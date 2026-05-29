// ============================================================
// Catalyst Building Walk — Auto-Email + Drive Storage Script
// Version 2.1
// ============================================================
//
// SETUP / UPDATE INSTRUCTIONS:
// 1. Go to script.google.com, open your "Building Walk Emailer" project
// 2. Delete ALL old code and paste this entire file
// 3. Save (floppy disk icon)
// 4. If first time: select "setup" from dropdown, click Run, authorize
// 5. Deploy → Manage deployments → pencil → New version → Deploy
//
// The script URL stays the same after updating the version.
// ============================================================

const FOLDER_NAME = 'Building Walk Reports';
const SHEET_NAME = 'Building Walk Log';

function setup() {
  // Create the Drive folder
  let folders = DriveApp.getFoldersByName(FOLDER_NAME);
  let folder;
  if (folders.hasNext()) {
    folder = folders.next();
    Logger.log('Folder already exists: ' + folder.getId());
  } else {
    folder = DriveApp.createFolder(FOLDER_NAME);
    Logger.log('Created folder: ' + folder.getId());
  }
  Logger.log('Folder URL: https://drive.google.com/drive/folders/' + folder.getId());

  // Create building subfolders
  var buildings = ['Alder', 'Aspen', 'Kingsway', 'Rivermark', 'Royal Oak', 'Telford', 'Timberline I'];
  buildings.forEach(function(name) {
    var subs = folder.getFoldersByName(name);
    if (!subs.hasNext()) {
      folder.createFolder(name);
      Logger.log('Created subfolder: ' + name);
    } else {
      Logger.log('Subfolder already exists: ' + name);
    }
  });

  // Create the spreadsheet log
  let files = DriveApp.getFilesByName(SHEET_NAME);
  let sheet;
  if (files.hasNext()) {
    let file = files.next();
    sheet = SpreadsheetApp.openById(file.getId());
    Logger.log('Sheet already exists: ' + sheet.getUrl());
  } else {
    sheet = SpreadsheetApp.create(SHEET_NAME);
    let sheetFile = DriveApp.getFileById(sheet.getId());
    folder.addFile(sheetFile);
    DriveApp.getRootFolder().removeFile(sheetFile);
    let ws = sheet.getActiveSheet();
    ws.setName('Walk Log');
    ws.appendRow([
      'Date', 'Building', 'Caretaker', 'Sections Completed',
      'New Deficiencies', 'Resolved Deficiencies', 'Outstanding Deficiencies',
      'PDF Link', 'Email Status', 'Submitted At'
    ]);
    ws.setFrozenRows(1);
    ws.getRange('1:1').setFontWeight('bold');
    Logger.log('Created sheet: ' + sheet.getUrl());
  }

  Logger.log('');
  Logger.log('=== SETUP COMPLETE ===');
  Logger.log('Folder: https://drive.google.com/drive/folders/' + folder.getId());
  Logger.log('Sheet: ' + sheet.getUrl());
}

function doPost(e) {
  var emailStatus = 'unknown';
  var pdfUrl = '';
  var data;
  
  try {
    data = JSON.parse(e.postData.contents);
  } catch (parseErr) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: 'Invalid JSON: ' + parseErr.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var to = data.to || '';
  var subject = data.subject || 'Building Walk Report';
  var body = data.body || '';
  var pdfBase64 = data.pdf || '';
  var filename = data.filename || 'report.pdf';
  var buildingName = data.buildingName || 'Unknown';
  var caretaker = data.caretaker || 'Unknown';
  var walkDate = data.walkDate || new Date().toISOString().slice(0, 10);
  var newDeficiencies = data.newDeficiencies || 0;
  var resolvedDeficiencies = data.resolvedDeficiencies || 0;
  var outstandingDeficiencies = data.outstandingDeficiencies || 0;
  var sectionsCompleted = data.sectionsCompleted || 0;

  // Decode the base64 PDF
  var pdfBlob;
  try {
    pdfBlob = Utilities.newBlob(
      Utilities.base64Decode(pdfBase64),
      'application/pdf',
      filename
    );
  } catch (decodeErr) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: 'PDF decode failed: ' + decodeErr.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // 1. Save to Drive (do this first so we have the file even if email fails)
  try {
    var folders = DriveApp.getFoldersByName(FOLDER_NAME);
    if (folders.hasNext()) {
      var mainFolder = folders.next();
      var targetFolder = mainFolder;
      var subs = mainFolder.getFoldersByName(buildingName);
      if (subs.hasNext()) {
        targetFolder = subs.next();
      }
      var savedFile = targetFolder.createFile(pdfBlob);
      pdfUrl = savedFile.getUrl();
    }
  } catch (driveErr) {
    Logger.log('Drive save error: ' + driveErr.toString());
    // Continue — email may still work
  }

  // 2. Email the report
  try {
    var pdfSizeBytes = pdfBlob.getBytes().length;
    var pdfSizeMB = pdfSizeBytes / (1024 * 1024);
    
    if (pdfSizeMB > 18) {
      // Gmail's hard limit is 25 MB on the ENCODED message; base64 inflates the
      // attachment ~37%, so a raw PDF over ~18 MB can be rejected. Fall back to a
      // Drive link BEFORE that happens so the PM always receives the report.
      // PDF too large for email attachment — send link to Drive file instead
      var emailBody = body + '\n\n' +
        '⚠ The PDF report (' + pdfSizeMB.toFixed(1) + ' MB) was too large to attach to this email.\n' +
        'It has been saved to Google Drive instead. You can view it here:\n' +
        pdfUrl + '\n';
      GmailApp.sendEmail(to, subject, emailBody, {
        name: 'Catalyst Building Walk'
      });
      emailStatus = 'sent_link_only (PDF ' + pdfSizeMB.toFixed(1) + 'MB)';
    } else {
      // Normal email with attachment
      GmailApp.sendEmail(to, subject, body, {
        attachments: [pdfBlob],
        name: 'Catalyst Building Walk'
      });
      emailStatus = 'sent_with_attachment';
    }
  } catch (emailErr) {
    Logger.log('Email error: ' + emailErr.toString());
    emailStatus = 'failed: ' + emailErr.toString();
    
    // If we have a Drive URL, try sending just the link
    if (pdfUrl) {
      try {
        var fallbackBody = body + '\n\n' +
          '⚠ The PDF could not be attached. It has been saved to Google Drive:\n' +
          pdfUrl + '\n';
        GmailApp.sendEmail(to, subject + ' (Drive link)', fallbackBody, {
          name: 'Catalyst Building Walk'
        });
        emailStatus = 'fallback_link_sent';
      } catch (fallbackErr) {
        Logger.log('Fallback email also failed: ' + fallbackErr.toString());
        emailStatus = 'all_failed: ' + emailErr.toString();
      }
    }
  }

  // 3. Log to spreadsheet
  try {
    var files = DriveApp.getFilesByName(SHEET_NAME);
    if (files.hasNext()) {
      var sheetFile = files.next();
      var ss = SpreadsheetApp.openById(sheetFile.getId());
      var ws = ss.getSheetByName('Walk Log') || ss.getActiveSheet();
      ws.appendRow([
        walkDate,
        buildingName,
        caretaker,
        sectionsCompleted,
        newDeficiencies,
        resolvedDeficiencies,
        outstandingDeficiencies,
        pdfUrl,
        emailStatus,
        new Date().toISOString()
      ]);
    }
  } catch (sheetErr) {
    Logger.log('Sheet log error: ' + sheetErr.toString());
  }

  return ContentService
    .createTextOutput(JSON.stringify({ 
      success: emailStatus.indexOf('failed') === -1,
      emailStatus: emailStatus,
      pdfUrl: pdfUrl
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'Building Walk Emailer is running', version: '2.1' }))
    .setMimeType(ContentService.MimeType.JSON);
}
