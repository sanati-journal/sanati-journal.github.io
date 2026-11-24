/*
  Order and photo receiver for the journal order page (Google Apps Script, free).
  Everything is saved in your Google Drive, in "Journal orders/<order>/":
   - photos, one file per character
   - draft.txt: saved when the customer reaches the last step and enters a phone number
   - order.txt: saved when the customer taps "Send order" (even if they never send the WhatsApp message)
  Folder names start with the status: DRAFT, NEW. The daily task renames NEW to PDF READY.

  Setup (once): script.google.com > New project > paste this file > Deploy > New deployment >
  type "Web app", Execute as "Me", Who has access "Anyone" > Deploy > authorise.
  Copy the web app URL (ends with /exec) into SHOP.photoUpload in design/index.html.
*/
var ROOT_NAME = "Journal orders";
var MAX_BYTES = 4 * 1024 * 1024;   // per photo
var MAX_PER_ORDER = 8;             // photos per order
var MAX_PER_DAY = 300;             // photos per day, all customers
var MAX_ORDERS_PER_DAY = 300;      // order and draft saves per day, all customers
var MAX_TEXT = 200000;             // characters per saved order

function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function clean(s) { return String(s || "").replace(/[\\\/:*?"<>|\[\]\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80); }
function rootFolder(props) {
  var id = props.getProperty("root");
  if (id) { try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  var made = DriveApp.createFolder(ROOT_NAME); props.setProperty("root", made.getId()); return made;
}
function stamp() { return Utilities.formatDate(new Date(), "Africa/Cairo", "yyyy-MM-dd HH.mm"); }
function putText(folder, name, text) {
  var old = folder.getFilesByName(name);
  while (old.hasNext()) old.next().setTrashed(true);
  folder.createFile(name, text, MimeType.PLAIN_TEXT);
}
function saveOrder(d, id, props, folder) {
  var text = String(d.text || "");
  if (text.length < 20 || text.length > MAX_TEXT) return out({ ok: false, error: "text" });
  var day = "t" + Utilities.formatDate(new Date(), "UTC", "yyyyMMdd"), n = +(props.getProperty(day) || 0);
  if (n >= MAX_ORDERS_PER_DAY) return out({ ok: false, error: "busy" });
  var sent = props.getProperty("s" + id) === "new";
  if (d.action === "draft" && sent) return out({ ok: true, skipped: true });
  if (!folder) {
    folder = rootFolder(props).createFolder(stamp() + " [" + id + "]");
    props.setProperty("o" + id, folder.getId());
  }
  var label = clean(d.label);
  if (d.action === "order") {
    putText(folder, "order.txt", text);
    var dr = folder.getFilesByName("draft.txt"); while (dr.hasNext()) dr.next().setTrashed(true);
    if (!sent) folder.setName("NEW " + stamp() + (label ? " " + label : "") + " [" + id + "]");
    props.setProperty("s" + id, "new");
  } else {
    putText(folder, "draft.txt", text);
    folder.setName("DRAFT " + stamp() + (label ? " " + label : "") + " [" + id + "]");
  }
  props.setProperty(day, String(n + 1));
  return out({ ok: true, folder: folder.getUrl() });
}
function doGet() { return out({ ok: true, service: "journal photos" }); }
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var d = JSON.parse((e.postData && e.postData.contents) || "{}");
    var id = String(d.order || "").replace(/[^a-z0-9]/gi, "").slice(0, 16);
    if (id.length < 8) return out({ ok: false, error: "order" });
    lock.waitLock(25000);
    var props = PropertiesService.getScriptProperties(), fid = props.getProperty("o" + id), folder = null;
    if (fid) { try { folder = DriveApp.getFolderById(fid); } catch (x) { folder = null; } }
    if (d.action === "order" || d.action === "draft") return saveOrder(d, id, props, folder);
    if (d.action === "name") return out({ ok: true });   // old pages; the order save names the folder now
    if (!/^image\/(jpeg|png|webp)$/.test(d.type || "")) return out({ ok: false, error: "type" });
    var bytes = Utilities.base64Decode(String(d.data || ""));
    if (!bytes.length || bytes.length > MAX_BYTES) return out({ ok: false, error: "size" });
    var day = "n" + Utilities.formatDate(new Date(), "UTC", "yyyyMMdd"), n = +(props.getProperty(day) || 0);
    if (n >= MAX_PER_DAY) return out({ ok: false, error: "busy" });
    if (!folder) {
      folder = rootFolder(props).createFolder(Utilities.formatDate(new Date(), "Africa/Cairo", "yyyy-MM-dd HH.mm") + " [" + id + "]");
      props.setProperty("o" + id, folder.getId());
    }
    var name = (clean(d.name) || "photo") + ".jpg", old = folder.getFilesByName(name);
    while (old.hasNext()) old.next().setTrashed(true);           // same person, new photo: replace
    var count = 0, all = folder.getFiles(); while (all.hasNext()) { if (!all.next().isTrashed()) count++; }
    if (count >= MAX_PER_ORDER) return out({ ok: false, error: "full" });
    folder.createFile(Utilities.newBlob(bytes, d.type, name));
    props.setProperty(day, String(n + 1));
    return out({ ok: true, folder: folder.getUrl() });
  } catch (err) {
    return out({ ok: false, error: "error" });
  } finally {
    try { lock.releaseLock(); } catch (z) {}
  }
}
