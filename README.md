<img src="public/assets/brand/CornFieldLogo1.png" alt="CornField logo" width="120" />

# CornField

![Node.js](https://img.shields.io/badge/Node.js-202020?style=flat&logo=nodedotjs&logoColor=5FA04E)
![SQLite](https://img.shields.io/badge/SQLite-202020?style=flat&logo=sqlite&logoColor=54B4EB)
![JavaScript](https://img.shields.io/badge/JavaScript-202020?style=flat&logo=javascript&logoColor=F7DF1E)
![HTML](https://img.shields.io/badge/HTML-202020?style=flat&logo=html5&logoColor=E34F26)
![CSS](https://img.shields.io/badge/CSS-202020?style=flat&logo=css&logoColor=663399)
![Docker](https://img.shields.io/badge/Docker-202020?style=flat&logo=docker&logoColor=2496ED)

CornField is a browser video player for videos you already have. It reads from a local folder, an external drive, or a mounted NAS share.

## Get started

1. Download and extract this repository, or clone it.
2. Open the launcher for your computer:
   - macOS: double-click `openCornField.command`.
   - Windows: double-click `openCornField.cmd`.
3. Go to Settings, set Library Folder Path, and click Scan Library.

The first scan is how your videos show up. Scan again from Settings after you add or remove files.

The launcher installs what it needs the first time. If Node.js is missing, it opens the download page; install Node.js and run the launcher again. On macOS, if the launcher is blocked, allow it in System Settings → Privacy & Security → Open Anyway.

You can also open it at [localhost:4300](http://localhost:4300). Keep the terminal window open while using it.

With Node.js installed, `npm install` and `npm start` from the repository folder also work.

## Optional: NAS or home server

To run CornField on a NAS or another computer with Docker, copy `.env.example` to `.env` and set `CORNFIELD_LIBRARY_PATH` to your video folder. If other devices should connect, set `CORNFIELD_BIND_ADDRESS` to that machine's local network IP.

```bash
docker compose up -d --build
```

Open `http://<server-ip>:4300`, set Library Folder Path to `/library`, and click Scan Library. CornField has no sign-in, so keep it on a trusted network.
