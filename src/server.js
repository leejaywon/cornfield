import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { rankRelatedVideos } from './recommendations.js';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import chokidar from 'chokidar';
import mime from 'mime-types';
import {
  db,
  getSetting,
  setSetting,
  getSettingsObject,
  replaceVideoTags,
  replaceVideoStarrings,
  touchVideo,
  isoNow
} from './db.js';
import { cleanupInterruptedLibraryScanState, previewLibraryScan, scanLibrary } from './media-indexer.js';
import {
  cleanupStaleTimelinePreviewTemps,
  deleteTimelinePreviewCache,
  ensureTimelinePreviewManifest,
  timelinePreviewRoot
} from './timeline-previews.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const publicRoot = path.join(projectRoot, 'public');
const dataRoot = path.join(projectRoot, 'data');
const thumbnailRoot = path.join(projectRoot, 'data', 'thumbnails');
const sqliteFilePaths = [path.join(dataRoot, 'videoplayer.db'), path.join(dataRoot, 'videoplayer.db-wal'), path.join(dataRoot, 'videoplayer.db-shm')];
const execFileAsync = promisify(execFile);

if (!fs.existsSync(thumbnailRoot)) {
  fs.mkdirSync(thumbnailRoot, { recursive: true });
}

if (!fs.existsSync(timelinePreviewRoot)) {
  fs.mkdirSync(timelinePreviewRoot, { recursive: true });
}

const app = Fastify({
  logger: false,
  bodyLimit: 25 * 1024 * 1024
});

app.register(fastifyMultipart);
app.register(fastifyStatic, {
  root: publicRoot,
  prefix: '/'
});
app.register(fastifyStatic, {
  root: thumbnailRoot,
  prefix: '/thumbnails/',
  decorateReply: false
});
app.register(fastifyStatic, {
  root: timelinePreviewRoot,
  prefix: '/timeline-previews/',
  decorateReply: false
});

function parseCsv(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function mergeDateInputIntoCreatedAt(existingCreatedAt, rawDate) {
  const nextDate = String(rawDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) {
    return null;
  }

  const existing = String(existingCreatedAt || '').trim();
  if (existing.length > 10) {
    return `${nextDate}${existing.slice(10)}`;
  }

  return `${nextDate}T00:00:00.000Z`;
}

function normalizeTagName(name) {
  return String(name || '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u02BC\uFF07\u2032]/g, "'")
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
    .replace(/[\p{Cf}\p{Cc}]/gu, '')
    .replace(/\s*-\s*/g, '-')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeTagKey(name) {
  return normalizeTagName(name).toLowerCase();
}

function toTagTitleCase(name) {
  return normalizeTagName(name)
    .split(' ')
    .map((word) =>
      word
        .split('-')
        .map((part) => {
          if (!part) return part;
          if (/^[A-Z0-9]+$/.test(part) && part.length <= 4) return part;
          return `${part.charAt(0).toLocaleUpperCase()}${part.slice(1).toLocaleLowerCase()}`;
        })
        .join('-')
    )
    .join(' ');
}

function sanitizeFileName(fileName) {
  if (!fileName) return null;
  if (fileName.includes('/') || fileName.includes('\\')) return null;
  return fileName.trim();
}

async function deleteManagedThumbnail(thumbnailPath) {
  const normalized = String(thumbnailPath || '').trim();
  if (!normalized.startsWith('/thumbnails/')) {
    return;
  }

  const relativeName = normalized.slice('/thumbnails/'.length).split('?')[0];
  const safeFileName = sanitizeFileName(decodePathParam(relativeName));
  if (!safeFileName) {
    return;
  }

  const absPath = path.join(thumbnailRoot, safeFileName);
  if (!isPathInsideRoot(thumbnailRoot, absPath)) {
    return;
  }

  try {
    await fsp.unlink(absPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

function decodePathParam(input) {
  const value = String(input || '');
  if (!value) return '';

  try {
    return decodeURIComponent(value);
  } catch {
    // Fastify may already have decoded the path. A second decodeURIComponent
    // then throws on literal "%" in filenames (e.g. "0% Pussy").
    return value;
  }
}

function getLibraryRootOrThrow() {
  const libraryRoot = getSetting('libraryRoot');
  if (!libraryRoot) {
    throw new Error('Library root is not configured. Set it in settings first.');
  }
  return path.resolve(libraryRoot);
}

function parseRating(value, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const rating = Number(value);
  if (!Number.isFinite(rating) || rating < 0 || rating > 5) {
    return null;
  }

  const halved = Math.round(rating * 2);
  if (Math.abs(rating * 2 - halved) > 1e-9) {
    return null;
  }

  return halved / 2;
}

function toAppleScriptString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function toPowerShellSingleQuotedString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function normalizePathForComparison(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInsideRoot(rootPath, candidatePath) {
  const normalizedRoot = normalizePathForComparison(rootPath);
  const normalizedCandidate = normalizePathForComparison(candidatePath);
  const relativePath = path.relative(normalizedRoot, normalizedCandidate);

  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

async function selectFolderFromFinder(initialPath = '', prompt = 'Select your video library folder') {
  if (process.platform !== 'darwin') {
    return null;
  }

  const trimmedInitialPath = String(initialPath || '').trim();
  let defaultLocationClause = '';

  if (trimmedInitialPath) {
    const resolvedInitialPath = path.resolve(trimmedInitialPath);
    try {
      const stat = await fsp.stat(resolvedInitialPath);
      if (stat.isDirectory()) {
        defaultLocationClause = ` default location POSIX file ${toAppleScriptString(resolvedInitialPath)}`;
      }
    } catch {
      // Ignore invalid initial path and fall back to Finder's default location.
    }
  }

  const script = [
    `set chosenFolder to choose folder with prompt ${toAppleScriptString(prompt)}${defaultLocationClause}`,
    'POSIX path of chosenFolder'
  ];

  try {
    const { stdout } = await execFileAsync('osascript', script.flatMap((line) => ['-e', line]));
    return String(stdout || '').trim();
  } catch (error) {
    if (/user canceled/i.test(String(error.stderr || error.message || ''))) {
      return null;
    }
    throw error;
  }
}

async function selectFolderFromWindows(initialPath = '', prompt = 'Select your video library folder') {
  if (process.platform !== 'win32') {
    return null;
  }

  const trimmedInitialPath = String(initialPath || '').trim();
  let selectedPathLine = '';

  if (trimmedInitialPath) {
    const resolvedInitialPath = path.resolve(trimmedInitialPath);
    try {
      const stat = await fsp.stat(resolvedInitialPath);
      if (stat.isDirectory()) {
        selectedPathLine = `$dialog.SelectedPath = ${toPowerShellSingleQuotedString(resolvedInitialPath)}`;
      }
    } catch {
      // Ignore invalid initial path and fall back to the dialog default.
    }
  }

  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$dialog.Description = ${toPowerShellSingleQuotedString(prompt)}`,
    '$dialog.ShowNewFolderButton = $false',
    selectedPathLine,
    '$result = $dialog.ShowDialog()',
    'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }'
  ]
    .filter(Boolean)
    .join('; ');

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', script],
      { windowsHide: true }
    );
    return String(stdout || '').trim() || null;
  } catch (error) {
    throw new Error(error.stderr || error.message || 'Could not open the Windows folder picker.');
  }
}

async function selectFolderFromSystemDialog(initialPath = '', prompt = 'Select your video library folder') {
  if (process.platform === 'darwin') {
    return selectFolderFromFinder(initialPath, prompt);
  }

  if (process.platform === 'win32') {
    return selectFolderFromWindows(initialPath, prompt);
  }

  const error = new Error('Folder picker is currently available on macOS and Windows only. Enter the path manually instead.');
  error.statusCode = 501;
  throw error;
}

function buildRandomOrderBy(seedRaw) {
  const modulus = 2147483647n;
  const mask = Number(modulus);
  const normalizedSeed = Number.isFinite(seedRaw) ? BigInt(Math.trunc(Math.abs(seedRaw))) : 0n;
  let mix = normalizedSeed % modulus;

  if (mix === 0n) {
    mix = 1n;
  }

  const advanceMix = (value) => ((value * 48271n) + 12820163n) % modulus;

  mix = advanceMix(mix);
  const linearA = Number(mix | 1n);
  mix = advanceMix(mix + (normalizedSeed / modulus) + 1n);
  const quadraticA = Number(mix | 1n);
  mix = advanceMix(mix + 97n);
  const linearB = Number(mix | 1n);
  mix = advanceMix(mix + 193n);
  const quadraticB = Number(mix | 1n);
  mix = advanceMix(mix + 389n);
  const linearC = Number(mix | 1n);
  mix = advanceMix(mix + 769n);
  const quadraticC = Number(mix | 1n);
  const offsetA = Number((normalizedSeed / modulus) % modulus);
  const offsetB = Number(normalizedSeed % modulus);
  const offsetC = Number((normalizedSeed % 1000003n) + 7n);

  return `
    (((v.id * ${linearA}) + (((v.id * v.id) & ${mask}) * ${quadraticA}) + ${offsetA}) & ${mask}),
    ((((v.id + ${offsetB} + 1) * ${linearB}) + ((((v.id + 11) * (v.id + 11)) & ${mask}) * ${quadraticB})) & ${mask}),
    (((((v.id * 31) + ${offsetC}) * ${linearC}) + ((((v.id + 23) * (v.id + 23)) & ${mask}) * ${quadraticC})) & ${mask}),
    v.id DESC
  `;
}

function serializeVideoRow(row) {
  const tags = row.tags_csv ? row.tags_csv.split(',').filter(Boolean) : [];
  const starrings = row.starrings_csv ? row.starrings_csv.split(',').filter(Boolean) : [];
  const ratingCount = Number(row.rating_count || 0);
  const mediaPath = row.relative_path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  return {
    id: row.id,
    relativePath: row.relative_path,
    fileName: row.file_name,
    displayTitle: row.display_title,
    description: row.description,
    originalCreatedAt: row.original_created_at,
    duration: row.duration,
    width: row.width,
    height: row.height,
    qualityBucket: row.quality_bucket,
    category: row.category,
    viewCount: row.view_count,
    thumbnailPath: row.thumbnail_path,
    thumbnailTime: row.thumbnail_time,
    averageRating: ratingCount > 0 ? Number(row.average_rating) : null,
    ratingCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags,
    starrings,
    mediaUrl: `/media/${mediaPath}`
  };
}

function parsePreviewDirectoryVideoId(dirName) {
  const match = /^video-(\d+)$/.exec(String(dirName || ''));
  if (!match) {
    return null;
  }

  const videoId = Number(match[1]);
  return Number.isInteger(videoId) && videoId > 0 ? videoId : null;
}

async function getFileSizeSafe(absPath) {
  try {
    const stat = await fsp.stat(absPath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

async function walkDirectoryStats(rootPath, onFile) {
  let entries;

  try {
    entries = await fsp.readdir(rootPath, { withFileTypes: true });
  } catch {
    return { bytes: 0, fileCount: 0 };
  }

  let bytes = 0;
  let fileCount = 0;

  for (const entry of entries) {
    const absPath = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      const nested = await walkDirectoryStats(absPath, onFile);
      bytes += nested.bytes;
      fileCount += nested.fileCount;
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const stat = await fsp.stat(absPath).catch(() => null);
    if (!stat) {
      continue;
    }

    bytes += stat.size;
    fileCount += 1;
    await onFile?.({ absPath, entryName: entry.name, stat });
  }

  return { bytes, fileCount };
}

async function readPreviewSample(videoId) {
  const manifestPath = path.join(timelinePreviewRoot, `video-${videoId}`, 'manifest.json');
  let rawManifest;

  try {
    rawManifest = await fsp.readFile(manifestPath, 'utf8');
  } catch {
    return null;
  }

  let manifest;
  try {
    manifest = JSON.parse(rawManifest);
  } catch {
    return null;
  }

  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  const selectedItem = items[Math.floor(items.length / 2)] || items[0];

  if (!selectedItem?.imageUrl) {
    return null;
  }

  const row = db
    .prepare("SELECT id AS videoId, display_title AS displayTitle FROM videos WHERE id = ? AND is_missing = 0 AND file_name NOT LIKE '._%'")
    .get(videoId);

  if (!row) {
    return null;
  }

  return {
    videoId: row.videoId,
    displayTitle: row.displayTitle,
    imageUrl: selectedItem.imageUrl,
    frameCount: items.length
  };
}

async function buildDatabaseSummary() {
  const sampleLimit = 8;
  const overview = db
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM videos WHERE file_name NOT LIKE '._%' AND is_missing = 0) AS total_videos,
        (SELECT COUNT(*) FROM videos WHERE file_name NOT LIKE '._%' AND is_missing = 1) AS missing_videos,
        (SELECT COUNT(*) FROM videos WHERE file_name NOT LIKE '._%' AND is_missing = 0 AND thumbnail_path IS NOT NULL AND TRIM(thumbnail_path) <> '') AS thumbnail_count,
        (SELECT COUNT(DISTINCT category) FROM videos WHERE file_name NOT LIKE '._%' AND is_missing = 0 AND TRIM(category) <> '') AS category_count,
        (SELECT COALESCE(SUM(duration), 0) FROM videos WHERE file_name NOT LIKE '._%' AND is_missing = 0) AS total_duration_sec,
        (SELECT COALESCE(SUM(view_count), 0) FROM videos WHERE file_name NOT LIKE '._%' AND is_missing = 0) AS total_views,
        (SELECT COUNT(*) FROM tags) AS tag_count,
        (SELECT COUNT(*) FROM starrings) AS starring_count,
        (SELECT COUNT(*) FROM comments) AS comment_count,
        (SELECT COUNT(*) FROM timeline_notes) AS note_count,
        (SELECT MAX(updated_at) FROM videos WHERE file_name NOT LIKE '._%' AND is_missing = 0) AS last_updated_at
    `)
    .get();

  const [thumbnailStats, sqliteSizes, previewRootEntries, thumbnailSamples] = await Promise.all([
    walkDirectoryStats(thumbnailRoot),
    Promise.all(sqliteFilePaths.map((absPath) => getFileSizeSafe(absPath))),
    fsp.readdir(timelinePreviewRoot, { withFileTypes: true }).catch(() => []),
    Promise.resolve(
      db
        .prepare(`
          SELECT
            id AS videoId,
            display_title AS displayTitle,
            thumbnail_path AS imageUrl
          FROM videos
          WHERE is_missing = 0
            AND file_name NOT LIKE '._%'
            AND thumbnail_path IS NOT NULL
            AND TRIM(thumbnail_path) <> ''
          ORDER BY updated_at DESC, id DESC
          LIMIT ?
        `)
        .all(sampleLimit)
    )
  ]);

  const previewVideoIds = previewRootEntries
    .map((entry) => (entry.isDirectory() ? parsePreviewDirectoryVideoId(entry.name) : null))
    .filter((videoId) => Number.isInteger(videoId));

  let previewManifestCount = 0;
  let previewFrameCount = 0;
  let previewBytes = 0;
  let previewFileCount = 0;

  for (const videoId of previewVideoIds) {
    const previewDir = path.join(timelinePreviewRoot, `video-${videoId}`);
    const stats = await walkDirectoryStats(previewDir, ({ entryName }) => {
      if (entryName === 'manifest.json') {
        previewManifestCount += 1;
        return;
      }

      if (/\.(jpe?g|png|webp)$/i.test(entryName)) {
        previewFrameCount += 1;
      }
    });

    previewBytes += stats.bytes;
    previewFileCount += stats.fileCount;
  }

  const samplePreviews = [];
  const sortedPreviewVideoIds = [...previewVideoIds].sort((a, b) => b - a);

  for (const videoId of sortedPreviewVideoIds) {
    const sample = await readPreviewSample(videoId);
    if (!sample) {
      continue;
    }

    samplePreviews.push(sample);
    if (samplePreviews.length >= sampleLimit) {
      break;
    }
  }

  const sqliteBytes = sqliteSizes.reduce((sum, value) => sum + Number(value || 0), 0);

  return {
    totals: {
      totalVideos: Number(overview?.total_videos || 0),
      missingVideos: Number(overview?.missing_videos || 0),
      thumbnailCount: Number(overview?.thumbnail_count || 0),
      previewCount: previewVideoIds.length,
      previewFrameCount,
      categoryCount: Number(overview?.category_count || 0),
      totalDurationSec: Number(overview?.total_duration_sec || 0),
      totalViews: Number(overview?.total_views || 0),
      tagCount: Number(overview?.tag_count || 0),
      starringCount: Number(overview?.starring_count || 0),
      commentCount: Number(overview?.comment_count || 0),
      noteCount: Number(overview?.note_count || 0),
      lastUpdatedAt: overview?.last_updated_at || null
    },
    storage: {
      sqliteBytes,
      thumbnailBytes: thumbnailStats.bytes,
      previewBytes,
      generatedBytes: sqliteBytes + thumbnailStats.bytes + previewBytes,
      thumbnailFileCount: thumbnailStats.fileCount,
      previewFileCount,
      previewManifestCount
    },
    samples: {
      thumbnails: thumbnailSamples,
      previews: samplePreviews
    }
  };
}

let watcher = null;
let scanInFlight = null;
let pendingWatchScanTimer = null;
let scanStatus = {
  inProgress: false,
  phase: 'idle',
  scannedCount: null,
  totalCount: null,
  currentFile: null,
  startedAt: null,
  finishedAt: null,
  error: ''
};
const commentRatingStatsJoin = `
  LEFT JOIN (
    SELECT video_id, AVG(rating) AS average_rating, COUNT(*) AS rating_count
    FROM comments
    WHERE rated_at IS NOT NULL
    GROUP BY video_id
  ) cr ON cr.video_id = v.id
`;

function mergeScanStatus(patch = {}) {
  const nextStatus = {
    ...scanStatus,
    ...patch
  };

  if (Object.hasOwn(patch, 'scannedCount')) {
    const scannedCount = patch.scannedCount;
    nextStatus.scannedCount = scannedCount === null ? null : Math.max(0, Math.floor(Number(scannedCount) || 0));
  }

  if (Object.hasOwn(patch, 'totalCount')) {
    const totalCount = patch.totalCount;
    nextStatus.totalCount = totalCount === null ? null : Math.max(0, Math.floor(Number(totalCount) || 0));
  }

  if (Object.hasOwn(patch, 'error')) {
    nextStatus.error = String(patch.error || '');
  }

  scanStatus = nextStatus;
  return scanStatus;
}

async function runScan(libraryRootOverride = null) {
  if (scanInFlight) {
    return scanInFlight;
  }

  scanInFlight = (async () => {
    const libraryRoot = libraryRootOverride ? path.resolve(libraryRootOverride) : getLibraryRootOrThrow();
    mergeScanStatus({
      inProgress: true,
      phase: 'discovering',
      scannedCount: 0,
      totalCount: null,
      currentFile: null,
      startedAt: isoNow(),
      finishedAt: null,
      error: ''
    });

    const result = await scanLibrary(libraryRoot, {
      onProgress(progress) {
        mergeScanStatus({
          inProgress: true,
          phase: progress.phase || scanStatus.phase,
          scannedCount: progress.scannedCount,
          totalCount: progress.totalCount,
          currentFile: progress.currentFile || null
        });
      }
    });

    mergeScanStatus({
      inProgress: false,
      phase: 'idle',
      scannedCount: result.scannedCount,
      totalCount: result.scannedCount,
      currentFile: null,
      startedAt: result.scannedAt || scanStatus.startedAt,
      finishedAt: isoNow(),
      error: ''
    });
    return result;
  })();

  try {
    return await scanInFlight;
  } catch (error) {
    mergeScanStatus({
      inProgress: false,
      phase: 'error',
      currentFile: null,
      finishedAt: isoNow(),
      error: error.message || 'Library scan failed.'
    });
    throw error;
  } finally {
    scanInFlight = null;
  }
}

function scheduleWatchScan() {
  if (pendingWatchScanTimer) {
    clearTimeout(pendingWatchScanTimer);
  }

  pendingWatchScanTimer = setTimeout(async () => {
    try {
      await runScan();
    } catch {
      // Ignore watch-triggered scan failures and keep server running.
    }
  }, 1200);
}

async function configureWatcher() {
  const libraryRoot = getSetting('libraryRoot');
  if (!libraryRoot) return;

  const resolved = path.resolve(libraryRoot);

  if (watcher) {
    await watcher.close();
    watcher = null;
  }

  try {
    await fsp.access(resolved);
  } catch {
    return;
  }

  watcher = chokidar.watch(resolved, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval: 100
    }
  });

  watcher.on('all', () => {
    scheduleWatchScan();
  });
}

app.get('/api/health', async () => ({ ok: true }));

app.get('/api/settings', async () => {
  const settings = getSettingsObject();
  return {
    folderPickerAvailable: ['darwin', 'win32'].includes(process.platform),
    libraryRoot: settings.libraryRoot || '',
    skipSeconds: Number(settings.skipSeconds || 10),
    libraryRows: Number(settings.libraryRows || 3),
    controlsHideMs: Number(settings.controlsHideMs || 2500)
  };
});

app.post('/api/system/select-folder', async (request, reply) => {
  try {
    const selectedPath = await selectFolderFromSystemDialog(
      request.body?.initialPath || '',
      String(request.body?.prompt || 'Select your video library folder')
    );
    return {
      ok: true,
      cancelled: !selectedPath,
      path: selectedPath || ''
    };
  } catch (error) {
    const statusCode = Number(error.statusCode) || 500;
    return reply.code(statusCode).send({ error: error.message || 'Could not open the system folder picker.' });
  }
});

app.put('/api/settings', async (request, reply) => {
  const body = request.body || {};
  const updates = [];

  if (Object.hasOwn(body, 'libraryRoot')) {
    const rawRoot = String(body.libraryRoot || '').trim();
    if (rawRoot) {
      const resolved = path.resolve(rawRoot);
      try {
        const stat = await fsp.stat(resolved);
        if (!stat.isDirectory()) {
          return reply.code(400).send({ error: 'libraryRoot must be a valid directory path.' });
        }
      } catch {
        return reply.code(400).send({ error: 'libraryRoot does not exist.' });
      }
      setSetting('libraryRoot', resolved);
      updates.push('libraryRoot');
    } else {
      return reply.code(400).send({ error: 'libraryRoot cannot be empty.' });
    }
  }

  if (Object.hasOwn(body, 'skipSeconds')) {
    const value = Number(body.skipSeconds);
    if (![2.5, 5, 10, 15].includes(value)) {
      return reply.code(400).send({ error: 'skipSeconds must be one of 2.5, 5, 10, 15.' });
    }
    setSetting('skipSeconds', String(value));
    updates.push('skipSeconds');
  }

  if (Object.hasOwn(body, 'libraryRows')) {
    const value = Number(body.libraryRows);
    if (!Number.isInteger(value) || value < 1 || value > 8) {
      return reply.code(400).send({ error: 'libraryRows must be an integer between 1 and 8.' });
    }
    setSetting('libraryRows', String(value));
    updates.push('libraryRows');
  }

  if (Object.hasOwn(body, 'controlsHideMs')) {
    const value = Number(body.controlsHideMs);
    if (!Number.isInteger(value) || (value !== 0 && (value < 1000 || value > 15000))) {
      return reply.code(400).send({ error: 'controlsHideMs must be 0, or an integer between 1000 and 15000.' });
    }
    setSetting('controlsHideMs', String(value));
    updates.push('controlsHideMs');
  }

  if (updates.includes('libraryRoot')) {
    await configureWatcher();
  }

  return {
    ok: true,
    updated: updates,
    settings: {
      libraryRoot: getSetting('libraryRoot', ''),
      skipSeconds: Number(getSetting('skipSeconds', 10)),
      libraryRows: Number(getSetting('libraryRows', 3)),
      controlsHideMs: Number(getSetting('controlsHideMs', 2500))
    }
  };
});

app.post('/api/library/scan', async (request, reply) => {
  const body = request.body || {};
  let libraryRoot = getSetting('libraryRoot', '');

  if (body.libraryRoot) {
    const resolved = path.resolve(String(body.libraryRoot));
    try {
      const stat = await fsp.stat(resolved);
      if (!stat.isDirectory()) {
        return reply.code(400).send({ error: 'Provided libraryRoot is not a directory.' });
      }
    } catch {
      return reply.code(400).send({ error: 'Provided libraryRoot does not exist.' });
    }

    setSetting('libraryRoot', resolved);
    libraryRoot = resolved;
    await configureWatcher();
  }

  if (!libraryRoot) {
    return reply.code(400).send({ error: 'Library root is not configured.' });
  }

  try {
    const result = await runScan(libraryRoot);
    return { ok: true, ...result };
  } catch (error) {
    return reply.code(400).send({ error: error.message });
  }
});

app.post('/api/library/scan/preview', async (request, reply) => {
  const body = request.body || {};
  let libraryRoot = getSetting('libraryRoot', '');

  if (body.libraryRoot) {
    const resolved = path.resolve(String(body.libraryRoot));
    try {
      const stat = await fsp.stat(resolved);
      if (!stat.isDirectory()) {
        return reply.code(400).send({ error: 'Provided libraryRoot is not a directory.' });
      }
    } catch {
      return reply.code(400).send({ error: 'Provided libraryRoot does not exist.' });
    }
    libraryRoot = resolved;
  }

  if (!libraryRoot) {
    return reply.code(400).send({ error: 'Library root is not configured.' });
  }

  try {
    const result = await previewLibraryScan(libraryRoot);
    return { ok: true, ...result };
  } catch (error) {
    return reply.code(400).send({ error: error.message });
  }
});

app.get('/api/library/scan/status', async () => {
  return {
    ok: true,
    ...scanStatus
  };
});

app.get('/api/videos', async (request) => {
  const query = request.query || {};
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize || 24)));
  const offset = (page - 1) * pageSize;

  const whereClauses = ["v.is_missing = 0", "v.file_name NOT LIKE '._%'"];
  const params = [];

  if (query.q) {
    const q = `%${String(query.q).trim()}%`;
    whereClauses.push(`(
      v.display_title LIKE ?
      OR v.file_name LIKE ?
      OR v.category LIKE ?
      OR v.quality_bucket LIKE ?
      OR CAST(v.height AS TEXT) LIKE ?
      OR EXISTS (
        SELECT 1 FROM video_tags vt_q
        JOIN tags t_q ON t_q.id = vt_q.tag_id
        WHERE vt_q.video_id = v.id AND t_q.name LIKE ?
      )
      OR EXISTS (
        SELECT 1 FROM video_starrings vs_q
        JOIN starrings s_q ON s_q.id = vs_q.starring_id
        WHERE vs_q.video_id = v.id AND s_q.name LIKE ?
      )
    )`);
    params.push(q, q, q, q, q, q, q);
  }

  if (query.tag) {
    whereClauses.push(`EXISTS (
      SELECT 1 FROM video_tags vt
      JOIN tags t ON t.id = vt.tag_id
      WHERE vt.video_id = v.id AND t.name = ? COLLATE NOCASE
    )`);
    params.push(normalizeTagName(String(query.tag)));
  }

  if (query.starring) {
    whereClauses.push(`EXISTS (
      SELECT 1 FROM video_starrings vs
      JOIN starrings s ON s.id = vs.starring_id
      WHERE vs.video_id = v.id AND s.name = ?
    )`);
    params.push(String(query.starring));
  }

  if (query.category) {
    whereClauses.push('v.category = ?');
    params.push(String(query.category));
  }

  if (query.qualityMin) {
    const qualityMin = Number(query.qualityMin);
    if (Number.isFinite(qualityMin) && qualityMin > 0) {
      whereClauses.push('v.height >= ?');
      params.push(qualityMin);
    }
  }

  if (query.fromDate) {
    whereClauses.push("date(substr(v.created_at, 1, 10)) >= date(?)");
    params.push(String(query.fromDate));
  }

  if (query.toDate) {
    whereClauses.push("date(substr(v.created_at, 1, 10)) <= date(?)");
    params.push(String(query.toDate));
  }

  const sort = String(query.sort || 'random');
  const randomSeedRaw = Number(query.randomSeed);
  const orderBy = {
    random: buildRandomOrderBy(randomSeedRaw),
    upload_desc: `v.created_at DESC, v.updated_at DESC, ${buildRandomOrderBy(randomSeedRaw)}`,
    upload_asc: `v.created_at ASC, v.updated_at ASC, ${buildRandomOrderBy(randomSeedRaw)}`,
    views_desc: `v.view_count DESC, MAX(cr.average_rating) DESC, ${buildRandomOrderBy(randomSeedRaw)}`,
    views_asc: `v.view_count ASC, MAX(cr.average_rating) DESC, ${buildRandomOrderBy(randomSeedRaw)}`,
    rating_desc: `CASE WHEN MAX(cr.rating_count) > 0 THEN 0 ELSE 1 END ASC, ROUND(COALESCE(MAX(cr.average_rating), 0), 1) DESC, MAX(cr.rating_count) DESC, v.view_count DESC, ${buildRandomOrderBy(randomSeedRaw)}`,
    rating_asc: `CASE WHEN MAX(cr.rating_count) > 0 THEN 0 ELSE 1 END ASC, ROUND(COALESCE(MAX(cr.average_rating), 0), 1) ASC, MAX(cr.rating_count) DESC, v.view_count DESC, ${buildRandomOrderBy(randomSeedRaw)}`
  }[sort] || buildRandomOrderBy(randomSeedRaw);

  const whereSql = `WHERE ${whereClauses.join(' AND ')}`;

  const countRow = db.prepare(`SELECT COUNT(*) AS total FROM videos v ${whereSql}`).get(...params);

  const rows = db
    .prepare(`
      SELECT
        v.*,
        MAX(cr.average_rating) AS average_rating,
        MAX(cr.rating_count) AS rating_count,
        GROUP_CONCAT(DISTINCT t.name) AS tags_csv,
        GROUP_CONCAT(DISTINCT s.name) AS starrings_csv
      FROM videos v
      ${commentRatingStatsJoin}
      LEFT JOIN video_tags vt ON vt.video_id = v.id
      LEFT JOIN tags t ON t.id = vt.tag_id
      LEFT JOIN video_starrings vs ON vs.video_id = v.id
      LEFT JOIN starrings s ON s.id = vs.starring_id
      ${whereSql}
      GROUP BY v.id
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `)
    .all(...params, pageSize, offset);

  return {
    page,
    pageSize,
    total: countRow.total,
    items: rows.map(serializeVideoRow)
  };
});

app.get('/api/videos/admin', async (request) => {
  const query = request.query || {};
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(500, Math.max(10, Number(query.pageSize || 80)));
  const offset = (page - 1) * pageSize;

  const whereClauses = ["1=1", "v.file_name NOT LIKE '._%'"];
  const params = [];

  if (query.q) {
    const q = `%${String(query.q).trim()}%`;
    whereClauses.push(`(
      v.display_title LIKE ?
      OR v.file_name LIKE ?
      OR v.category LIKE ?
      OR v.relative_path LIKE ?
      OR EXISTS (
        SELECT 1 FROM video_tags vt
        JOIN tags t ON t.id = vt.tag_id
        WHERE vt.video_id = v.id AND t.name LIKE ?
      )
      OR EXISTS (
        SELECT 1 FROM video_starrings vs
        JOIN starrings s ON s.id = vs.starring_id
        WHERE vs.video_id = v.id AND s.name LIKE ?
      )
    )`);
    params.push(q, q, q, q, q, q);
  }

  if (!query.includeMissing || String(query.includeMissing) !== '1') {
    whereClauses.push('v.is_missing = 0');
  }

  const whereSql = `WHERE ${whereClauses.join(' AND ')}`;
  const countRow = db.prepare(`SELECT COUNT(*) AS total FROM videos v ${whereSql}`).get(...params);

  const rows = db
    .prepare(
      `SELECT
         v.id,
         v.display_title AS displayTitle,
         v.file_name AS fileName,
         v.relative_path AS relativePath,
         v.category AS category,
         v.quality_bucket AS qualityBucket,
         v.height AS height,
         v.view_count AS viewCount,
         v.original_created_at AS originalCreatedAt,
         v.created_at AS createdAt,
         v.is_missing AS isMissing,
         v.updated_at AS updatedAt
       FROM videos v
       ${whereSql}
       ORDER BY v.updated_at DESC, v.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, offset);

  return {
    page,
    pageSize,
    total: countRow.total,
    items: rows
  };
});

app.get('/api/database/summary', async (request, reply) => {
  try {
    return await buildDatabaseSummary();
  } catch (error) {
    return reply.code(500).send({ error: error.message || 'Failed to build database summary.' });
  }
});

app.get('/api/videos/:id', async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return reply.code(400).send({ error: 'Invalid video id' });
  }

  const row = db
    .prepare(`
      SELECT
        v.*,
        MAX(cr.average_rating) AS average_rating,
        MAX(cr.rating_count) AS rating_count,
        GROUP_CONCAT(DISTINCT t.name) AS tags_csv,
        GROUP_CONCAT(DISTINCT s.name) AS starrings_csv
      FROM videos v
      ${commentRatingStatsJoin}
      LEFT JOIN video_tags vt ON vt.video_id = v.id
      LEFT JOIN tags t ON t.id = vt.tag_id
      LEFT JOIN video_starrings vs ON vs.video_id = v.id
      LEFT JOIN starrings s ON s.id = vs.starring_id
      WHERE v.id = ? AND v.file_name NOT LIKE '._%'
      GROUP BY v.id
    `)
    .get(id);

  if (!row) {
    return reply.code(404).send({ error: 'Video not found' });
  }

  return { video: serializeVideoRow(row) };
});

app.get('/api/videos/:id/previews', async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return reply.code(400).send({ error: 'Invalid video id' });
  }

  const row = db.prepare('SELECT relative_path AS relativePath, duration FROM videos WHERE id = ?').get(id);
  if (!row) {
    return reply.code(404).send({ error: 'Video not found' });
  }

  let libraryRoot;
  try {
    libraryRoot = getLibraryRootOrThrow();
  } catch (error) {
    return reply.code(400).send({ error: error.message });
  }

  const absPath = path.resolve(libraryRoot, row.relativePath);
  if (!isPathInsideRoot(libraryRoot, absPath)) {
    return reply.code(403).send({ error: 'Path is outside library root' });
  }

  try {
    const stat = await fsp.stat(absPath);
    if (!stat.isFile()) {
      return { available: false, items: [] };
    }
  } catch {
    return { available: false, items: [] };
  }

  const manifest = await ensureTimelinePreviewManifest({
    videoId: id,
    absPath,
    durationSec: Number(row.duration || 0)
  });

  if (!manifest) {
    return { available: false, items: [] };
  }

  return {
    available: true,
    duration: manifest.duration,
    intervalSec: manifest.intervalSec,
    width: manifest.width,
    items: manifest.items
  };
});

app.put('/api/videos/:id/metadata', async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return reply.code(400).send({ error: 'Invalid video id' });
  }

  const existing = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
  if (!existing) {
    return reply.code(404).send({ error: 'Video not found' });
  }

  const body = request.body || {};
  const nextTitle = String(body.displayTitle ?? existing.display_title).trim();
  const nextDescription = String(body.description ?? existing.description).trim();
  const nextCreatedAtInput = body.createdAtDate ?? body.uploadDate;
  const nextCreatedAt =
    nextCreatedAtInput === undefined ? existing.created_at : mergeDateInputIntoCreatedAt(existing.created_at, nextCreatedAtInput);
  const nextCategory = String(body.category ?? existing.category).trim();
  const nextViewCount = Number(body.viewCount ?? existing.view_count);

  if (!nextTitle) {
    return reply.code(400).send({ error: 'displayTitle is required.' });
  }

  if (!Number.isFinite(nextViewCount) || nextViewCount < 0) {
    return reply.code(400).send({ error: 'viewCount must be >= 0.' });
  }

  if (!nextCreatedAt) {
    return reply.code(400).send({ error: 'createdAtDate must be a valid YYYY-MM-DD date.' });
  }

  db.prepare(`
    UPDATE videos
    SET
      display_title = ?,
      description = ?,
      created_at = ?,
      category = ?,
      view_count = ?,
      updated_at = ?
    WHERE id = ?
  `).run(nextTitle, nextDescription, nextCreatedAt, nextCategory, Math.floor(nextViewCount), isoNow(), id);

  if (Object.hasOwn(body, 'tags')) {
    replaceVideoTags(id, parseCsv(body.tags));
  }

  if (Object.hasOwn(body, 'starrings')) {
    replaceVideoStarrings(id, parseCsv(body.starrings));
  }

  return { ok: true };
});

app.post('/api/videos/:id/rename', async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return reply.code(400).send({ error: 'Invalid video id' });
  }

  const body = request.body || {};
  const existing = db.prepare('SELECT relative_path, file_name FROM videos WHERE id = ?').get(id);
  if (!existing) {
    return reply.code(404).send({ error: 'Video not found' });
  }

  const requestedName = sanitizeFileName(String(body.newFileName || ''));
  if (!requestedName) {
    return reply.code(400).send({ error: 'newFileName is invalid.' });
  }

  const ext = path.extname(existing.file_name);
  const requestedExt = path.extname(requestedName);
  if (requestedExt) {
    return reply.code(400).send({ error: 'Enter the file name without changing the extension.' });
  }

  const finalName = ext ? `${requestedName}${ext}` : requestedName;

  const relDir = path.posix.dirname(existing.relative_path);
  const newRelativePath = relDir === '.' ? finalName : `${relDir}/${finalName}`;

  const libraryRoot = getLibraryRootOrThrow();
  const oldAbs = path.resolve(libraryRoot, existing.relative_path);
  const newAbs = path.resolve(libraryRoot, newRelativePath);

  if (!isPathInsideRoot(libraryRoot, newAbs)) {
    return reply.code(400).send({ error: 'Invalid target path.' });
  }

  try {
    await fsp.access(newAbs);
    return reply.code(409).send({ error: 'A file with the same name already exists.' });
  } catch {
    // target does not exist
  }

  try {
    await fsp.rename(oldAbs, newAbs);
  } catch (error) {
    return reply.code(500).send({ error: `Failed to rename file: ${error.message}` });
  }

  db.prepare('UPDATE videos SET relative_path = ?, file_name = ?, updated_at = ? WHERE id = ?').run(
    newRelativePath,
    finalName,
    isoNow(),
    id
  );

  return { ok: true, newFileName: finalName, newRelativePath };
});

app.delete('/api/videos/:id', async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return reply.code(400).send({ error: 'Invalid video id' });
  }

  const existing = db.prepare('SELECT id, relative_path, thumbnail_path FROM videos WHERE id = ?').get(id);
  if (!existing) {
    return reply.code(404).send({ error: 'Video not found' });
  }

  const deleteFile = request.body?.deleteFile !== false;
  let fileDeleted = false;

  if (deleteFile) {
    let libraryRoot;
    try {
      libraryRoot = getLibraryRootOrThrow();
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }

    const absPath = path.resolve(libraryRoot, existing.relative_path);
    if (!isPathInsideRoot(libraryRoot, absPath)) {
      return reply.code(400).send({ error: 'Invalid file path' });
    }

    try {
      await fsp.unlink(absPath);
      fileDeleted = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        return reply.code(500).send({ error: `Failed to delete file: ${error.message}` });
      }
    }
  }

  try {
    await deleteManagedThumbnail(existing.thumbnail_path);
  } catch (error) {
    return reply.code(500).send({ error: `Failed to delete thumbnail: ${error.message}` });
  }

  db.prepare('DELETE FROM comments WHERE video_id = ?').run(id);
  db.prepare('DELETE FROM timeline_notes WHERE video_id = ?').run(id);
  db.prepare('DELETE FROM video_tags WHERE video_id = ?').run(id);
  db.prepare('DELETE FROM video_starrings WHERE video_id = ?').run(id);
  db.prepare('DELETE FROM videos WHERE id = ?').run(id);
  db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM video_tags)').run();
  db.prepare('DELETE FROM starrings WHERE id NOT IN (SELECT DISTINCT starring_id FROM video_starrings)').run();
  await deleteTimelinePreviewCache(id);

  return { ok: true, fileDeleted };
});

app.get('/api/videos/:id/comments', async (request, reply) => {
  const videoId = Number(request.params.id);
  if (!Number.isInteger(videoId) || videoId <= 0) {
    return reply.code(400).send({ error: 'Invalid video id' });
  }

  const comments = db
    .prepare(
      'SELECT id, video_id AS videoId, content, rating, rated_at AS ratedAt, created_at AS createdAt, updated_at AS updatedAt FROM comments WHERE video_id = ? ORDER BY created_at DESC'
    )
    .all(videoId);

  return { items: comments };
});

app.post('/api/videos/:id/comments', async (request, reply) => {
  const videoId = Number(request.params.id);
  if (!Number.isInteger(videoId) || videoId <= 0) {
    return reply.code(400).send({ error: 'Invalid video id' });
  }

  const body = request.body || {};
  const content = String(body.content || '').trim();
  const hasRating = Object.hasOwn(body, 'rating') && body.rating !== null && body.rating !== '';
  const rating = hasRating ? parseRating(body.rating) : 0;

  if (hasRating && rating === null) {
    return reply.code(400).send({ error: 'rating must be a multiple of 0.5 between 0 and 5.' });
  }
  if (!content && !hasRating) {
    return reply.code(400).send({ error: 'Enter a review or choose a rating.' });
  }

  const now = isoNow();
  const result = db
    .prepare('INSERT INTO comments(video_id, content, rating, rated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(videoId, content, rating, hasRating ? now : null, now, now);

  touchVideo(videoId);

  return { ok: true, id: result.lastInsertRowid };
});

app.put('/api/comments/:id', async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return reply.code(400).send({ error: 'Invalid review id' });
  }

  const body = request.body || {};
  const row = db.prepare('SELECT video_id, content, rating, rated_at FROM comments WHERE id = ?').get(id);
  if (!row) {
    return reply.code(404).send({ error: 'Review not found' });
  }

  const hasRatingUpdate = Object.hasOwn(body, 'rating');
  const content = Object.hasOwn(body, 'content') ? String(body.content ?? '').trim() : row.content;
  const nextHasRating = hasRatingUpdate ? body.rating !== null && body.rating !== '' : row.rated_at !== null;
  const rating = nextHasRating ? parseRating(hasRatingUpdate ? body.rating : row.rating) : 0;

  if (nextHasRating && rating === null) {
    return reply.code(400).send({ error: 'rating must be a multiple of 0.5 between 0 and 5.' });
  }
  if (!content && !nextHasRating) {
    return reply.code(400).send({ error: 'Enter a review or choose a rating.' });
  }

  const now = isoNow();
  const previousHasRating = row.rated_at !== null;
  const ratingChanged =
    hasRatingUpdate &&
    (nextHasRating !== previousHasRating || (nextHasRating && Number(row.rating) !== rating));
  const ratedAt = nextHasRating ? (ratingChanged ? now : row.rated_at || now) : null;

  db.prepare('UPDATE comments SET content = ?, rating = ?, rated_at = ?, updated_at = ? WHERE id = ?').run(content, rating, ratedAt, now, id);
  touchVideo(row.video_id);

  return { ok: true };
});

app.delete('/api/comments/:id', async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return reply.code(400).send({ error: 'Invalid review id' });
  }

  const row = db.prepare('SELECT video_id FROM comments WHERE id = ?').get(id);
  if (!row) {
    return reply.code(404).send({ error: 'Review not found' });
  }

  db.prepare('DELETE FROM comments WHERE id = ?').run(id);
  touchVideo(row.video_id);

  return { ok: true };
});

app.get('/api/videos/:id/notes', async (request, reply) => {
  const videoId = Number(request.params.id);
  if (!Number.isInteger(videoId) || videoId <= 0) {
    return reply.code(400).send({ error: 'Invalid video id' });
  }

  const notes = db
    .prepare(
      'SELECT id, video_id AS videoId, timestamp_sec AS timestampSec, memo, created_at AS createdAt, updated_at AS updatedAt FROM timeline_notes WHERE video_id = ? ORDER BY timestamp_sec ASC'
    )
    .all(videoId);

  return { items: notes };
});

app.post('/api/videos/:id/notes', async (request, reply) => {
  const videoId = Number(request.params.id);
  if (!Number.isInteger(videoId) || videoId <= 0) {
    return reply.code(400).send({ error: 'Invalid video id' });
  }

  const timestampSec = Number(request.body?.timestampSec);
  const memo = String(request.body?.memo || '').trim();

  if (!Number.isFinite(timestampSec) || timestampSec < 0) {
    return reply.code(400).send({ error: 'timestampSec must be >= 0.' });
  }
  if (!memo) {
    return reply.code(400).send({ error: 'memo is required.' });
  }

  const now = isoNow();
  const result = db
    .prepare('INSERT INTO timeline_notes(video_id, timestamp_sec, memo, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(videoId, timestampSec, memo, now, now);

  touchVideo(videoId);

  return { ok: true, id: result.lastInsertRowid };
});

app.put('/api/notes/:id', async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return reply.code(400).send({ error: 'Invalid note id' });
  }

  const note = db.prepare('SELECT video_id FROM timeline_notes WHERE id = ?').get(id);
  if (!note) {
    return reply.code(404).send({ error: 'Note not found' });
  }

  const timestampSec = Number(request.body?.timestampSec);
  const memo = String(request.body?.memo || '').trim();

  if (!Number.isFinite(timestampSec) || timestampSec < 0) {
    return reply.code(400).send({ error: 'timestampSec must be >= 0.' });
  }
  if (!memo) {
    return reply.code(400).send({ error: 'memo is required.' });
  }

  db.prepare('UPDATE timeline_notes SET timestamp_sec = ?, memo = ?, updated_at = ? WHERE id = ?').run(timestampSec, memo, isoNow(), id);
  touchVideo(note.video_id);

  return { ok: true };
});

app.delete('/api/notes/:id', async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return reply.code(400).send({ error: 'Invalid note id' });
  }

  const note = db.prepare('SELECT video_id FROM timeline_notes WHERE id = ?').get(id);
  if (!note) {
    return reply.code(404).send({ error: 'Note not found' });
  }

  db.prepare('DELETE FROM timeline_notes WHERE id = ?').run(id);
  touchVideo(note.video_id);

  return { ok: true };
});

app.post('/api/videos/:id/view', async (request, reply) => {
  const videoId = Number(request.params.id);
  if (!Number.isInteger(videoId) || videoId <= 0) {
    return reply.code(400).send({ error: 'Invalid video id' });
  }

  const result = db.prepare('UPDATE videos SET view_count = view_count + 1, updated_at = ? WHERE id = ?').run(isoNow(), videoId);
  if (!result.changes) {
    return reply.code(404).send({ error: 'Video not found' });
  }
  return { ok: true, changes: result.changes };
});

app.post('/api/videos/:id/thumbnail/upload', async (request, reply) => {
  const videoId = Number(request.params.id);
  if (!Number.isInteger(videoId) || videoId <= 0) {
    return reply.code(400).send({ error: 'Invalid video id' });
  }

  const file = await request.file();
  if (!file) {
    return reply.code(400).send({ error: 'No file was uploaded.' });
  }

  const ext = path.extname(file.filename || '').toLowerCase();
  const safeExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
  const fileName = `video-${videoId}-${Date.now()}${safeExt}`;
  const absPath = path.join(thumbnailRoot, fileName);

  await pipeline(file.file, fs.createWriteStream(absPath));

  db.prepare('UPDATE videos SET thumbnail_path = ?, updated_at = ? WHERE id = ?').run(`/thumbnails/${fileName}`, isoNow(), videoId);

  touchVideo(videoId);

  return { ok: true, thumbnailPath: `/thumbnails/${fileName}` };
});

app.post('/api/videos/:id/thumbnail/capture', async (request, reply) => {
  const videoId = Number(request.params.id);
  if (!Number.isInteger(videoId) || videoId <= 0) {
    return reply.code(400).send({ error: 'Invalid video id' });
  }

  const dataUrl = String(request.body?.dataUrl || '');
  const timestampSec = Number(request.body?.timestampSec || 0);
  const match = dataUrl.match(/^data:(image\/(png|jpeg|webp));base64,(.+)$/);

  if (!match) {
    return reply.code(400).send({ error: 'Invalid dataUrl format.' });
  }

  const mimeType = match[1];
  const base64 = match[3];
  const extMap = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp'
  };

  const ext = extMap[mimeType] || '.png';
  const fileName = `video-${videoId}-${Date.now()}${ext}`;
  const absPath = path.join(thumbnailRoot, fileName);

  await fsp.writeFile(absPath, Buffer.from(base64, 'base64'));

  db.prepare('UPDATE videos SET thumbnail_path = ?, thumbnail_time = ?, updated_at = ? WHERE id = ?').run(
    `/thumbnails/${fileName}`,
    Number.isFinite(timestampSec) ? timestampSec : null,
    isoNow(),
    videoId
  );

  touchVideo(videoId);

  return { ok: true, thumbnailPath: `/thumbnails/${fileName}` };
});

app.get('/api/videos/:id/related', async (request, reply) => {
  const videoId = Number(request.params.id);
  const limit = request.query?.limit || 12;

  if (!Number.isInteger(videoId) || videoId <= 0) {
    return reply.code(400).send({ error: 'Invalid video id' });
  }

  const source = db
    .prepare(
      `SELECT
         v.*,
         GROUP_CONCAT(DISTINCT t.name) AS tags_csv,
         GROUP_CONCAT(DISTINCT s.name) AS starrings_csv
       FROM videos v
       LEFT JOIN video_tags vt ON vt.video_id = v.id
       LEFT JOIN tags t ON t.id = vt.tag_id
       LEFT JOIN video_starrings vs ON vs.video_id = v.id
       LEFT JOIN starrings s ON s.id = vs.starring_id
       WHERE v.id = ? AND v.file_name NOT LIKE '._%'
       GROUP BY v.id`
    )
    .get(videoId);

  if (!source) {
    return reply.code(404).send({ error: 'Video not found' });
  }

  const candidates = db
    .prepare(
      `SELECT
         v.*,
         (SELECT MAX(ws.started_at) FROM watch_sessions ws WHERE ws.video_id = v.id AND ws.watched_seconds >= 30) AS last_watched_at,
         MAX(cr.average_rating) AS average_rating,
         MAX(cr.rating_count) AS rating_count,
         GROUP_CONCAT(DISTINCT t.name) AS tags_csv,
         GROUP_CONCAT(DISTINCT s.name) AS starrings_csv
       FROM videos v
       ${commentRatingStatsJoin}
       LEFT JOIN video_tags vt ON vt.video_id = v.id
       LEFT JOIN tags t ON t.id = vt.tag_id
       LEFT JOIN video_starrings vs ON vs.video_id = v.id
       LEFT JOIN starrings s ON s.id = vs.starring_id
       WHERE v.id <> ? AND v.is_missing = 0 AND v.file_name NOT LIKE '._%'
       GROUP BY v.id`
    )
    .all(videoId);

  return { items: rankRelatedVideos(source, candidates, limit, Date.now(), String(request.query?.seed || randomUUID()).slice(0, 128)).map(serializeVideoRow) };
});

app.get('/api/tags', async (request) => {
  const starringFilter = String(request.query?.starring || '').trim();
  const starringClause = starringFilter
    ? `AND EXISTS (
         SELECT 1 FROM video_starrings vs
         JOIN starrings s ON s.id = vs.starring_id
         WHERE vs.video_id = v.id AND s.name = ?
       )`
    : '';

  const rows = db
    .prepare(
      `SELECT
         t.name,
         COUNT(vt.video_id) AS videoCount
       FROM tags t
       JOIN video_tags vt ON vt.tag_id = t.id
       JOIN videos v ON v.id = vt.video_id
       WHERE v.is_missing = 0 AND v.file_name NOT LIKE '._%'
       ${starringClause}
       GROUP BY t.id
       ORDER BY videoCount DESC, t.name ASC`
    )
    .all(...(starringFilter ? [starringFilter] : []));

  const mergedByKey = new Map();

  for (const row of rows) {
    const displayName = toTagTitleCase(row.name);
    const key = normalizeTagKey(displayName);
    if (!key) continue;

    if (!mergedByKey.has(key)) {
      mergedByKey.set(key, {
        name: displayName,
        videoCount: Number(row.videoCount || 0)
      });
      continue;
    }

    const existing = mergedByKey.get(key);
    existing.videoCount += Number(row.videoCount || 0);
  }

  const mergedItems = [...mergedByKey.values()].sort((a, b) => {
    if (b.videoCount !== a.videoCount) return b.videoCount - a.videoCount;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return { items: mergedItems };
});

app.get('/api/starrings', async () => {
  const rows = db
    .prepare(
      `SELECT
         s.name,
         COUNT(vs.video_id) AS videoCount
       FROM starrings s
       JOIN video_starrings vs ON vs.starring_id = s.id
       JOIN videos v ON v.id = vs.video_id
       WHERE v.is_missing = 0 AND v.file_name NOT LIKE '._%'
       GROUP BY s.id
       ORDER BY videoCount DESC, s.name ASC`
    )
    .all();

  return { items: rows };
});

app.get('/media/*', async (request, reply) => {
  let libraryRoot;
  try {
    libraryRoot = getLibraryRootOrThrow();
  } catch (error) {
    return reply.code(400).send({ error: error.message });
  }

  const wildcard = request.params['*'];
  const relative = decodePathParam(wildcard).replace(/\\/g, '/');
  if (!relative) {
    return reply.code(400).send({ error: 'Missing media path' });
  }

  const absPath = path.resolve(libraryRoot, relative);
  if (!isPathInsideRoot(libraryRoot, absPath)) {
    return reply.code(403).send({ error: 'Path is outside library root' });
  }

  let stat;
  try {
    stat = await fsp.stat(absPath);
    if (!stat.isFile()) {
      return reply.code(404).send({ error: 'File not found' });
    }
  } catch {
    return reply.code(404).send({ error: 'File not found' });
  }

  const contentType = mime.lookup(absPath) || 'application/octet-stream';
  const range = request.headers.range;

  reply.header('Content-Type', contentType);
  reply.header('Accept-Ranges', 'bytes');

  if (!range) {
    reply.header('Content-Length', stat.size);
    return reply.send(fs.createReadStream(absPath));
  }

  const [startPart, endPart] = String(range).replace(/bytes=/, '').split('-');
  let start = Number(startPart);
  let end = endPart ? Number(endPart) : stat.size - 1;

  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(end) || end >= stat.size) end = stat.size - 1;

  if (start > end || start >= stat.size) {
    reply.code(416);
    reply.header('Content-Range', `bytes */${stat.size}`);
    return reply.send();
  }

  reply.code(206);
  reply.header('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  reply.header('Content-Length', end - start + 1);
  return reply.send(fs.createReadStream(absPath, { start, end }));
});

app.get('/', async (_request, reply) => {
  return reply.sendFile('index.html');
});

const port = Number(process.env.PORT || 4300);
const host = process.env.HOST || '127.0.0.1';

async function start() {
  try {
    await configureWatcher();
    await cleanupStaleTimelinePreviewTemps();
    cleanupInterruptedLibraryScanState();
    await app.listen({ port, host });
    console.log(`CornField is running at http://${host}:${port}`);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

start();
