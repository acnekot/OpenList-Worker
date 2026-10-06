import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dist = path.join(root, "dist")
const layouts = fs.readdirSync(path.join(dist, "assets")).filter((name) => /^Layout-.*\.js$/.test(name) && !name.includes("legacy"))
if (layouts.length !== 1) throw new Error(`Expected one modern Layout bundle, found ${layouts.length}`)

const layoutPath = path.join(dist, "assets", layouts[0])
let layout = fs.readFileSync(layoutPath, "utf8")
const before = "O(Z,{as:fn,tips:`upload`,onClick:()=>{I.emit(`tool`,`upload`)}})"
const after = "O(Z,{as:fn,tips:`upload`,class:`catsuki-upload-icon`,onClick:()=>{I.emit(`tool`,`upload`)}})"
if (layout.includes(before)) layout = layout.replace(before, after)
else if (!layout.includes(after)) throw new Error("Upload control in official frontend changed; review the bundle before deploying")
const closed = "defaultIsOpen:localStorage.getItem(`more-open`)===`true`"
const opened = "defaultIsOpen:!0"
if (layout.includes(closed)) layout = layout.replace(closed, opened)
else if (!layout.includes(opened)) throw new Error("Toolbar default in official frontend changed; review the bundle before deploying")
fs.writeFileSync(layoutPath, layout)

// The released frontend checks only the permission bitmask, while OpenList's
// administrator role grants all permissions regardless of the stored mask.
// Keep the frontend's upload control in step with the backend's role check.
for (const name of fs.readdirSync(path.join(dist, "assets")).filter((name) => /^store(?:-legacy)?-.*\.js$/.test(name))) {
  const storePath = path.join(dist, "assets", name)
  let store = fs.readFileSync(storePath, "utf8")
  const permissionCheck = "can:(e,t)=>(e.permission>>t&1)==1"
  const adminCheck = "can:(e,t)=>e.role===2||(e.permission>>t&1)==1"
  if (store.includes(permissionCheck)) store = store.replace(permissionCheck, adminCheck)
  else if (!store.includes(adminCheck)) throw new Error(`Permission check in ${name} changed; review before deploying`)
  fs.writeFileSync(storePath, store)
}

const htmlPath = path.join(dist, "index.html")
let html = fs.readFileSync(htmlPath, "utf8")
const clientScript = fs.readFileSync(path.join(root, "scripts", "frontend-upload-client.js"), "utf8")
const backgroundScript = fs.readFileSync(path.join(root, "scripts", "frontend-background.js"), "utf8")
const enhancement = `
<style>
  #catsuki-background{position:fixed;inset:0;width:100%;height:100%;object-fit:cover;object-position:center;pointer-events:none;z-index:0;opacity:0;transition:opacity .4s ease}
  #catsuki-background.loaded{opacity:.3}
  #root{position:relative;z-index:1}
  @media(prefers-reduced-motion:reduce){#catsuki-background{transition:none}}
  #catsuki-upload-button{display:inline-flex;align-self:flex-start;align-items:center;gap:.4rem;margin:.25rem 0 0;padding:.45rem .8rem;border:0;border-radius:.55rem;background:#2684e8;color:white;font:600 .9rem system-ui;cursor:pointer}
  #catsuki-upload-button:hover{background:#1269c3}
  #catsuki-upload-button:focus-visible{outline:2px solid currentColor;outline-offset:2px}
  #catsuki-folder-button{display:inline-flex;align-self:flex-start;margin:.35rem 0 0;padding:.4rem .75rem;border:1px solid #2684e8;border-radius:.55rem;background:transparent;color:#2684e8;font:600 .85rem system-ui;cursor:pointer}
  #catsuki-folder-dialog{position:fixed;top:20%;left:50%;transform:translateX(-50%);z-index:10000;display:grid;gap:.65rem;width:min(24rem,calc(100vw - 2rem));padding:1rem;border:1px solid #6b7280;border-radius:.7rem;background:#25292f;color:#fff;box-shadow:0 8px 28px #0008;font:14px system-ui}
  #catsuki-folder-dialog input{padding:.5rem;border:1px solid #6b7280;border-radius:.4rem;background:#17191c;color:#fff;font:inherit}
  #catsuki-folder-dialog button{padding:.4rem .75rem;cursor:pointer;border-radius:.4rem;border:1px solid #6b7280;background:#374151;color:#fff}
  #catsuki-folder-dialog button[type=submit]{background:#2684e8;border-color:#2684e8}
  #catsuki-drive-quota{align-self:flex-start;margin:.4rem 0 .3rem;padding:.55rem .8rem;border-radius:.55rem;background:rgba(38,132,232,.1);font:500 .82rem system-ui;color:inherit}
  .catsuki-upload-icon{display:none!important}
  #catsuki-upload-progress{position:fixed;left:1rem;bottom:1rem;z-index:9999;display:grid;gap:.45rem;width:min(25rem,calc(100vw - 2rem));padding:1rem;border-radius:.7rem;background:#25292f;color:white;box-shadow:0 8px 28px #0008;font:14px system-ui}
  #catsuki-upload-progress strong{font-size:1rem}
  #catsuki-upload-progress .catsuki-upload-name{font-weight:600;overflow-wrap:anywhere}
  #catsuki-upload-progress .catsuki-upload-actions{display:flex;justify-content:flex-end;gap:.5rem;margin-top:.25rem}
  #catsuki-upload-progress progress{width:100%}
  #catsuki-upload-progress button{padding:.4rem .75rem;cursor:pointer;border-radius:.4rem;border:1px solid #6b7280;background:#374151;color:white}
  #catsuki-upload-progress button:disabled{opacity:.55;cursor:wait}
</style>
<script>
${clientScript}
${backgroundScript}
</script>
`
html = html.replace(/<!-- catsuki upload enhancement -->[\s\S]*?<!-- end catsuki upload enhancement -->/, "")
html = html.replace(/<style>\s*#catsuki-upload-button[\s\S]*?<\/script>\s*/, "")
html = html.replace("<!-- customize head -->", `<!-- customize head -->\n<!-- catsuki upload enhancement -->${enhancement}<!-- end catsuki upload enhancement -->`)
fs.writeFileSync(htmlPath, html)
console.log("Front-end upload button enabled")
