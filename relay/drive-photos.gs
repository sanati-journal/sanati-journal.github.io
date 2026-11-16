/*
  Photo receiver for the journal order page (Google Apps Script, free).
  Customers' photos are saved in your Google Drive, in "Journal orders/<order>/".
  The order message on WhatsApp carries the link to that folder.

  Setup (once): script.google.com > New project > paste this file > Deploy > New deployment >
  type "Web app", Execute as "Me", Who has access "Anyone" > Deploy > authorise.
  Copy the web app URL (ends with /exec) into SHOP.photoUpload in design/index.html.
*/
var ROOT_NAME = "Journal orders";
var MAX_BYTES = 4 * 1024 * 1024;   // per photo
var MAX_PER_ORDER = 8;             // photos per order
var MAX_PER_DAY = 300;             // photos per day, all customers

function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function clean(s) { return String(s || "").replace(/[\\\/:*?"<>|\[\]\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80); }
function rootFolder(props) {
  var id = props.getProperty("root");
  if (id) { try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  var made = DriveApp.createFolder(ROOT_NAME); props.setProperty("root", made.getId()); return made;
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
    if (d.action === "name") {
      if (folder && d.label) folder.setName(Utilities.formatDate(new Date(), "Africa/Cairo", "yyyy-MM-dd") + " " + clean(d.label) + " [" + id + "]");
      return out({ ok: true });
    }
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
