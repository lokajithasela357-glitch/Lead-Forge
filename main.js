// --- Upgrading an existing install ------------------------------------------
// This installer needs NO special upgrade code -- electron-builder's NSIS
// target (see package.json's "build.nsis") already handles it out of the
// box, as long as two things stay true release over release:
//   1. "build.appId" (com.codegen.leadforge) never changes -- that's the
//      key electron-builder/NSIS uses to recognize "this is the same app,
//      just a newer build" instead of a totally different program.
//   2. The top-level "version" field in package.json is BUMPED for every
//      release (it's baked into the installer's metadata/registry entry).
// When someone who already has LeadForge installed runs a newer installer,
// NSIS detects the existing install via the registry, silently uninstalls
// the old version's files (deleteAppDataOnUninstall:false means their
// saved theme/session/local settings are left alone), and installs the new
// version in the same location -- no separate "repair" or "update" mode to
// build, it's just running the installer again. Someone with nothing
// installed yet gets the ordinary first-time install wizard, same file.
//
// IMPORTANT for future releases: bump BOTH this package.json's "version"
// AND the app script's APP_VERSION constant together, and publish that same
// number from User Management -> App Updates -- these three need to agree
// for the in-app "new version available" popup and the installer's own
// upgrade detection to both make sense together.
const { app, BrowserWindow, shell, ipcMain, dialog, session } = require("electron");
const path = require("path");
const fs = require("fs");

const PROTOCOL = "leadforge";
let mainWindow = null;
let pendingDeepLinkHash = null;

// --- "Are you sure you want to quit?" confirmation --------------------------
// Set once the renderer's own in-app confirmation modal has been accepted --
// both the window-close and app-quit interceptors below let the close/quit
// through unconditionally once this is true, so confirming never has to
// fight its own follow-up close event.
let exitConfirmed = false;

// --- Single instance lock -------------------------------------------------
// If the app is already running and the user clicks a leadforge:// link
// (e.g. a password-reset email link), the OS launches a second process.
// We forward that URL to the already-running window instead of opening a
// second copy of the app.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (event, argv) => {
    const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (url) {
      // handleDeepLink() already restores/focuses the window in this case.
      handleDeepLink(url);
    } else if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// --- Custom protocol registration ----------------------------------------
// Lets a real emailed password-reset link (leadforge://reset?...) hand
// control back to this installed app instead of a browser.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

function indexUrl() {
  return "file://" + path.join(__dirname, "app", "index.html");
}

// Convert a leadforge://reset?code=...&type=recovery (or, for older emails
// still out there, #access_token=...&type=recovery) link into a plain query
// string and deliver it to the app.
//
// If the window doesn't exist yet (a fresh launch), we stash it and let
// createWindow() load the app with it already attached to the URL -- a
// genuine first load, so the app's own startup code (isRecoveryRedirect(),
// Supabase's own detectSessionInUrl handling) picks it up naturally.
//
// If the window is ALREADY open and showing the app, we do NOT call
// loadURL() again: navigating to the exact same file:// path with only a
// different hash is a same-document fragment navigation in Chromium (the
// same thing that happens when you click a same-page anchor link in a
// browser) -- it updates window.location.hash but does NOT re-execute the
// page's script. Since Electron has no visible address bar, that made the
// app appear to do nothing at all: it came to the foreground, but never
// re-ran isRecoveryRedirect() or Supabase's own init logic, so the reset
// screen never appeared. Instead we hand the params to the already-running
// renderer over IPC (see preload.js) and it completes the exchange itself.
function handleDeepLink(url) {
  try {
    const parsed = new URL(url);
    const params = parsed.search || (parsed.hash ? "?" + parsed.hash.slice(1) : "");
    const queryString = params.replace(/^\?/, "");
    if (mainWindow) {
      mainWindow.webContents.send("leadforge-deep-link", { queryString });
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else {
      pendingDeepLinkHash = "#" + queryString;
    }
  } catch (e) {
    console.error("Could not parse deep link:", url, e);
  }
}

// macOS delivers the protocol URL via this event.
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#0a0a0d",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  const loadUrl = pendingDeepLinkHash ? indexUrl() + pendingDeepLinkHash : indexUrl();
  pendingDeepLinkHash = null;
  mainWindow.loadURL(loadUrl);

  // Keep normal http(s) links (if any ever appear) opening in the system
  // browser rather than inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Intercept the window's own close (the titlebar X, Alt+F4, taskbar
  // "Close window") -- this is the hook that actually matters on Windows/
  // Linux, since closing the last window happens here BEFORE the app-level
  // "before-quit" event ever fires (that only comes after, once
  // window-all-closed calls app.quit()). Asking the renderer to confirm
  // through its own styled modal, instead of just letting the window
  // vanish, means an accidental click never silently loses unsaved
  // in-progress work (a half-typed message, a drawer left open, etc.).
  mainWindow.on("close", (e) => {
    if (exitConfirmed) return;
    e.preventDefault();
    if (mainWindow) mainWindow.webContents.send("leadforge-confirm-exit");
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(() => {
  // Windows/Linux: a leadforge:// link launching a fresh instance of the
  // app arrives as a plain argv entry.
  const launchUrl = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (launchUrl) handleDeepLink(launchUrl);

  // Auto-grant the "notifications" permission for this trusted, single-
  // purpose internal desktop CRM -- no untrusted third-party content is
  // ever loaded in this window, so there's no one else's permission prompt
  // to protect the user from. This removes any dependence on Chromium's
  // per-origin permission memory persisting correctly for a bare file://
  // origin across app restarts (the suspected reason the notification
  // prompt was reappearing every login) -- the renderer's own
  // requestNotificationPermission() localStorage flag (see app script)
  // additionally makes sure Notification.requestPermission() itself is
  // still only ever called once, but this handler is what guarantees the
  // browser-level answer is always "granted" so that one call always
  // succeeds instead of possibly re-prompting.
  //
  // "media" is Electron's single permission bucket covering both
  // getUserMedia(audio) and getUserMedia(video) -- granted here ONLY for
  // an audio-only request (Messages' voice-message recorder is the one
  // thing in this app that ever calls getUserMedia, and it always asks for
  // audio alone). `details.mediaTypes` lists which of the two were
  // actually requested; a request that includes "video" is refused, since
  // nothing in this app has any legitimate use for the camera.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission === "notifications") { callback(true); return; }
    if (permission === "media") {
      const types = (details && details.mediaTypes) || [];
      callback(types.includes("video") ? false : types.includes("audio"));
      return;
    }
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => permission === "notifications" || permission === "media");

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Catches the quit paths that DON'T go through the window's own "close"
// event above -- macOS's Cmd+Q / Quit LeadForge menu item, or any future
// app.quit() call -- so those can't bypass the same confirmation. Guarded
// the same way: already-confirmed quits (including the app.quit() this
// file itself calls once confirmed, below) sail through untouched.
app.on("before-quit", (e) => {
  if (exitConfirmed) return;
  if (!mainWindow) return; // nothing to confirm against -- let it quit
  e.preventDefault();
  mainWindow.webContents.send("leadforge-confirm-exit");
});

// The renderer's own "Quit LeadForge?" modal (see app.jsx) sends this once
// the person actually clicks Quit -- only then does the app really close.
ipcMain.on("leadforge-exit-confirmed", () => {
  exitConfirmed = true;
  app.quit();
});

// --- Export to PDF --------------------------------------------------------
// The renderer's usePdfExport() hook calls this (via preload.js's
// leadforgePdf.exportPdf bridge) instead of window.print() whenever it's
// running inside this desktop shell. webContents.printToPDF renders with
// printBackground:true unconditionally, so the exported file always keeps
// the app's real theme colors (dark or light, whichever is active) with no
// OS print dialog "Background graphics" checkbox for the person to miss --
// that checkbox being unchecked by default is exactly why exports used to
// come out white and washed-out.
ipcMain.handle("leadforge-export-pdf", async (event, opts) => {
  if (!mainWindow) return { error: "No window is open." };
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: "Export to PDF",
      defaultPath: (opts && opts.suggestedName) || "LeadForge-Report.pdf",
      filters: [{ name: "PDF Document", extensions: ["pdf"] }],
    });
    if (canceled || !filePath) return { canceled: true };
    // preferCSSPageSize (instead of a hardcoded pageSize) hands page size AND
    // margins over to the page's own @page{size:A4 landscape;margin:...} CSS
    // rule (see index.html's print stylesheet). Without this, Chromium falls
    // back to its own default print margins on top of whatever the CSS
    // already specifies -- typically close to an inch on every side -- which
    // is why exports were coming out with the actual report shrunk into the
    // middle of the page instead of filling the printable area edge to edge
    // (modulo the small, deliberate margin the CSS itself asks for).
    const pdfBuffer = await mainWindow.webContents.printToPDF({
      printBackground: true,
      landscape: !opts || opts.landscape !== false,
      preferCSSPageSize: true,
    });
    await fs.promises.writeFile(filePath, pdfBuffer);
    return { success: true, filePath };
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
});
