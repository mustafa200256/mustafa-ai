import path from 'node:path';
import { TextDecoder } from 'node:util';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';

const maxFileBytes = 8 * 1024 * 1024;
const maxExtractedCharacters = 16000;
const maxZipExpandedBytes = 32 * 1024 * 1024;
const maxZipEntries = 2048;
const supportedTypes = new Map([
  ['.pdf', new Set(['application/pdf'])],
  ['.docx', new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document'])],
  ['.xlsx', new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])],
  ['.txt', new Set(['text/plain', 'application/octet-stream', ''])]
]);

export class DocumentServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'DocumentServiceError';
    this.status = status;
  }
}

function validateZipArchive(buffer) {
  const searchStart = Math.max(0, buffer.length - 0xffff - 22);
  let endRecord = -1;
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      endRecord = offset;
      break;
    }
  }
  if (endRecord < 0 || endRecord + 22 > buffer.length) {
    throw new DocumentServiceError(400, 'الملف غير صالح أو تالف.');
  }

  const entryCount = buffer.readUInt16LE(endRecord + 10);
  const centralSize = buffer.readUInt32LE(endRecord + 12);
  const centralOffset = buffer.readUInt32LE(endRecord + 16);
  if (
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    entryCount > maxZipEntries ||
    centralOffset + centralSize > endRecord
  ) {
    throw new DocumentServiceError(413, 'محتويات الأرشيف أكبر من الحدود الآمنة للمعالجة.');
  }

  let cursor = centralOffset;
  let expandedSize = 0;
  const entries = new Set();
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralOffset + centralSize || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new DocumentServiceError(400, 'الملف غير صالح أو تالف.');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    if (flags & 1 || uncompressedSize === 0xffffffff) {
      throw new DocumentServiceError(400, 'الملف محمي أو يستخدم تنسيقاً غير مدعوم.');
    }
    expandedSize += uncompressedSize;
    if (expandedSize > maxZipExpandedBytes) {
      throw new DocumentServiceError(413, 'محتوى الملف المضغوط أكبر من الحد الآمن للمعالجة.');
    }
    entries.add(buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  if (cursor > centralOffset + centralSize) {
    throw new DocumentServiceError(400, 'الملف غير صالح أو تالف.');
  }
  return entries;
}

function decodeBase64File(file) {
  if (
    !file ||
    typeof file !== 'object' ||
    typeof file.name !== 'string' ||
    typeof file.mimeType !== 'string' ||
    typeof file.data !== 'string'
  ) {
    throw new DocumentServiceError(400, 'تعذّر قراءة الملف المرفق. أعد اختياره وحاول مرة أخرى.');
  }

  const extension = path.extname(file.name).toLowerCase();
  const acceptedMimeTypes = supportedTypes.get(extension);
  if (!acceptedMimeTypes || !acceptedMimeTypes.has(file.mimeType.toLowerCase())) {
    throw new DocumentServiceError(415, 'نوع الملف غير مدعوم. ارفع PDF أو DOCX أو XLSX أو TXT.');
  }

  if (file.data.length === 0) {
    throw new DocumentServiceError(400, 'محتوى الملف غير صالح.');
  }
  if (file.data.length > Math.ceil(maxFileBytes * 4 / 3) + 4) {
    throw new DocumentServiceError(413, 'حجم الملف يجب ألا يتجاوز 8 ميغابايت.');
  }
  if (file.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(file.data)) {
    throw new DocumentServiceError(400, 'محتوى الملف غير صالح.');
  }

  const buffer = Buffer.from(file.data, 'base64');
  if (buffer.length === 0) {
    throw new DocumentServiceError(400, 'الملف فارغ.');
  }
  if (buffer.length > maxFileBytes) {
    throw new DocumentServiceError(413, 'حجم الملف يجب ألا يتجاوز 8 ميغابايت.');
  }
  if (buffer.toString('base64') !== file.data) {
    throw new DocumentServiceError(400, 'محتوى الملف غير صالح.');
  }

  return { buffer, extension };
}

function validatePdf(buffer) {
  if (buffer.length < 8 || buffer.toString('ascii', 0, 5) !== '%PDF-') {
    throw new DocumentServiceError(400, 'محتوى الملف لا يطابق صيغة PDF.');
  }
}

function validateOpenXml(entries, extension) {
  const hasCoreEntries = entries.has('[Content_Types].xml') &&
    (extension === '.docx'
      ? entries.has('word/document.xml')
      : entries.has('xl/workbook.xml'));
  if (!hasCoreEntries) {
    throw new DocumentServiceError(400, 'محتوى الملف لا يطابق صيغة Office المعلنة.');
  }
}

function trimExtractedText(text) {
  const normalized = text.replace(/\u0000/g, '').trim();
  if (!normalized) {
    throw new DocumentServiceError(422, 'لم أجد نصاً قابلاً للقراءة داخل الملف.');
  }
  return {
    text: normalized.slice(0, maxExtractedCharacters),
    truncated: normalized.length > maxExtractedCharacters
  };
}

async function extractPdf(buffer) {
  validatePdf(buffer);
  const parser = new PDFParse({ data: buffer, verbosity: 0 });
  try {
    const info = await parser.getInfo();
    const pageCount = Number(info.total);
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      throw new DocumentServiceError(422, 'ملف PDF لا يحتوي على صفحات قابلة للقراءة.');
    }
    const maxPages = 25;
    const pagesToRead = Math.min(pageCount, maxPages);
    const result = await parser.getText({
      partial: Array.from({ length: pagesToRead }, (_value, index) => index + 1)
    });
    const extracted = trimExtractedText(result.text);
    if (pageCount > maxPages) {
      extracted.truncated = true;
      extracted.text += `\n\n[اقتصر التحليل على أول ${maxPages} صفحة من أصل ${pageCount}.]`;
    }
    return extracted;
  } finally {
    await parser.destroy();
  }
}

async function extractDocx(buffer) {
  const entries = validateZipArchive(buffer);
  validateOpenXml(entries, '.docx');
  const result = await mammoth.extractRawText({ buffer });
  return trimExtractedText(result.value);
}

async function extractXlsx(buffer) {
  const entries = validateZipArchive(buffer);
  validateOpenXml(entries, '.xlsx');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const lines = [];
  const maxWorksheets = 20;
  const maxRowsPerWorksheet = 250;
  const maxColumnsPerRow = 30;
  let truncated = workbook.worksheets.length > maxWorksheets;
  for (const worksheet of workbook.worksheets.slice(0, maxWorksheets)) {
    lines.push(`ورقة العمل: ${worksheet.name}`);
    const rowsToRead = Math.min(worksheet.rowCount, maxRowsPerWorksheet);
    if (worksheet.rowCount > maxRowsPerWorksheet) truncated = true;
    for (let rowNumber = 1; rowNumber <= rowsToRead; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      const columnsToRead = Math.min(row.cellCount, maxColumnsPerRow);
      if (row.cellCount > maxColumnsPerRow) truncated = true;
      const cells = [];
      for (let column = 1; column <= columnsToRead; column += 1) {
        const value = row.getCell(column).text;
        cells.push(typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
      }
      const line = cells.join(' | ').trim();
      if (line.replaceAll('|', '').trim()) lines.push(line);
      if (lines.join('\n').length > maxExtractedCharacters) {
        truncated = true;
        break;
      }
    }
    if (lines.join('\n').length > maxExtractedCharacters) break;
  }

  const extracted = trimExtractedText(lines.join('\n'));
  extracted.truncated ||= truncated;
  return extracted;
}

async function extractTxt(buffer) {
  if (buffer.includes(0)) {
    throw new DocumentServiceError(400, 'ملف TXT يحتوي على بيانات ثنائية غير مدعومة.');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new DocumentServiceError(400, 'تعذّرت قراءة النص. احفظ ملف TXT بترميز UTF-8 ثم أعد رفعه.');
  }
  return trimExtractedText(text);
}

export async function extractDocument(file) {
  const { buffer, extension } = decodeBase64File(file);
  try {
    let extracted;
    if (extension === '.pdf') extracted = await extractPdf(buffer);
    else if (extension === '.docx') extracted = await extractDocx(buffer);
    else if (extension === '.xlsx') extracted = await extractXlsx(buffer);
    else extracted = await extractTxt(buffer);
    return {
      name: path.basename(file.name).replace(/[\r\n\u0000-\u001f]/g, '').slice(0, 160),
      ...extracted
    };
  } catch (error) {
    if (error instanceof DocumentServiceError) throw error;
    throw new DocumentServiceError(
      422,
      'تعذّرت قراءة الملف. تأكد أنه غير تالف وغير محمي بكلمة مرور ثم حاول مرة أخرى.'
    );
  }
}
