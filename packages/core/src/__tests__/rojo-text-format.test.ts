// Rojo delivers LF with no BOM into Studio (confirmed on the Windows run: a
// CRLF file on disk, LF in Studio). These are the pure conversions that let a
// file be compared and written back as itself while being read as Studio
// reads it.
import { describe, expect, test } from '@jest/globals';
import { detectFormat, toFileBytes, toStudioText } from '../rojo/text-format.js';

describe('detectFormat', () => {
  test('an LF file', () => {
    expect(detectFormat(Buffer.from('a\nb\n'))).toEqual({ bom: false, eol: 'lf' });
  });
  test('a CRLF file', () => {
    expect(detectFormat(Buffer.from('a\r\nb\r\n'))).toEqual({ bom: false, eol: 'crlf' });
  });
  test('a BOM is detected alongside the line ending', () => {
    expect(detectFormat(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\n')]))).toEqual({ bom: true, eol: 'crlf' });
  });
  test('no line breaks is lf', () => {
    expect(detectFormat(Buffer.from('a'))).toEqual({ bom: false, eol: 'lf' });
  });
  test('empty is lf', () => {
    expect(detectFormat(Buffer.from(''))).toEqual({ bom: false, eol: 'lf' });
  });
  test('a tie, or LF the majority, is lf', () => {
    expect(detectFormat(Buffer.from('a\r\nb\nc\n'))).toEqual({ bom: false, eol: 'lf' });
  });
});

describe('toStudioText', () => {
  test('strips a UTF-8 BOM and folds CRLF to LF', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\n')]);
    expect(toStudioText(bytes)).toBe('a\nb\n');
  });
  test('an LF file passes through unchanged', () => {
    expect(toStudioText(Buffer.from('a\nb\n'))).toBe('a\nb\n');
  });
  test('multi-byte UTF-8 survives', () => {
    expect(toStudioText(Buffer.from('café\r\n', 'utf8'))).toBe('café\n');
  });
});

describe('toFileBytes', () => {
  test('LF stays LF', () => {
    expect(toFileBytes('a\nb\n', { bom: false, eol: 'lf' })).toEqual(Buffer.from('a\nb\n'));
  });
  test('LF text is converted to CRLF for a CRLF file', () => {
    expect(toFileBytes('a\nb\n', { bom: false, eol: 'crlf' })).toEqual(Buffer.from('a\r\nb\r\n'));
  });
  test('a BOM is re-added', () => {
    expect(toFileBytes('a\n', { bom: true, eol: 'lf' })).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\n')]));
  });
  test('BOM and CRLF together', () => {
    expect(toFileBytes('a\nb\n', { bom: true, eol: 'crlf' })).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\n')]));
  });
});
