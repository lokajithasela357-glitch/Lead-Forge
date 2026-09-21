const { contextBridge, ipcRenderer } = require("electron");

// Lets the app know it's running inside the desktop shell so it can use the
// leadforge:// deep-link scheme (registered in main.js) as the Supabase
// password-reset redirect target instead of a plain web URL.
contextBridge.exposeInMainWorld("LEADFORGE_DESKTOP", true);

// Delivers a leadforge:// deep link's params to the renderer when the link
// is clicked while the app is ALREADY running (see main.js's handleDeepLink
// for why this can't just be a page reload). onDeepLink can be called more
// than once; each call adds another listener.
contextBridge.exposeInMainWorld("leadforgeDeepLink", {
  onDeepLink: (callback) => {
    ipcRenderer.on("leadforge-deep-link", (event, payload) => callback(payload));
  },
});

// Lets the renderer's "Export to PDF" buttons (Executive Dashboard, Sales
// Performance & Analytics) render straight to a chosen file via Electron's
// native printToPDF instead of opening the OS print dialog -- see main.js's
// "leadforge-export-pdf" handler for why (printBackground is always on, so
// exports keep the app's real theme colors with no checkbox to miss).
contextBridge.exposeInMainWorld("leadforgePdf", {
  exportPdf: (opts) => ipcRenderer.invoke("leadforge-export-pdf", opts || {}),
});

// Backs the "Are you sure you want to quit LeadForge?" confirmation --
// main.js intercepts the window's close (and the app's quit) and, instead
// of just closing, asks the renderer to show its own in-app modal (styled
// to match the rest of the app, not a bare OS dialog box). onConfirmExit
// fires when main.js wants that modal shown; confirmExit() is the
// renderer's answer once the person actually clicks "Quit LeadForge" --
// only then does the window/app actually close.
contextBridge.exposeInMainWorld("leadforgeExit", {
  onConfirmExit: (callback) => { ipcRenderer.on("leadforge-confirm-exit", () => callback()); },
  confirmExit: () => ipcRenderer.send("leadforge-exit-confirmed"),
});
