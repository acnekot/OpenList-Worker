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
const enhancement = `
<style>
  #catsuki-upload-button{display:inline-flex;align-self:flex-start;align-items:center;gap:.4rem;margin:.25rem 0 0;padding:.45rem .8rem;border:0;border-radius:.55rem;background:#2684e8;color:white;font:600 .9rem system-ui;cursor:pointer}
  #catsuki-upload-button:hover{background:#1269c3}
  #catsuki-upload-button:focus-visible{outline:2px solid currentColor;outline-offset:2px}
</style>
<script>
(() => {
  function syncUploadButton() {
    const icon = document.querySelector('.catsuki-upload-icon');
    const breadcrumb = document.querySelector('[aria-label="breadcrumb"]');
    let button = document.getElementById('catsuki-upload-button');
    if (!icon || !breadcrumb) { button?.remove(); return; }
    if (!button) {
      button = document.createElement('button');
      button.id = 'catsuki-upload-button';
      button.type = 'button';
      button.textContent = '↑ 上传文件';
      button.addEventListener('click', () => document.querySelector('.catsuki-upload-icon')?.dispatchEvent(new MouseEvent('click', {bubbles:true})));
      breadcrumb.after(button);
    }
  }
  addEventListener('DOMContentLoaded', () => {
    new MutationObserver(syncUploadButton).observe(document.getElementById('root'), {childList:true,subtree:true});
    syncUploadButton();
  });
})();
</script>
`
html = html.replace(/<!-- catsuki upload enhancement -->[\s\S]*?<!-- end catsuki upload enhancement -->/, "")
html = html.replace(/<style>\s*#catsuki-upload-button[\s\S]*?<\/script>\s*/, "")
html = html.replace("<!-- customize head -->", `<!-- customize head -->\n<!-- catsuki upload enhancement -->${enhancement}<!-- end catsuki upload enhancement -->`)
fs.writeFileSync(htmlPath, html)
console.log("Front-end upload button enabled")
