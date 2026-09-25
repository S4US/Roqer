// Self-contained baseline JPEG encoder (RGBA -> JFIF), no external deps —
// matching the hand-rolled PNG encoder in png-encoder.ts. Ported from the
// widely-used public implementation originally by Andreas Ritter
// (www.bytestrom.eu, 2009), as used in jpeg-js. Alpha is composited over
// black (screenshots are opaque, so this is a no-op in practice).
//
// Why JPEG: capture_screenshot returns the image inline as a tool result, and
// MCP clients cap result size (~1MB for Claude). A full-resolution play-mode
// PNG of a busy 3D scene blows past that; JPEG at quality ~80 is roughly a
// third the size and stays well under the cap.

/* eslint-disable */
const ZIGZAG = [
  0, 1, 5, 6, 14, 15, 27, 28,
  2, 4, 7, 13, 16, 26, 29, 42,
  3, 8, 12, 17, 25, 30, 41, 43,
  9, 11, 18, 24, 31, 40, 44, 53,
  10, 19, 23, 32, 39, 45, 52, 54,
  20, 22, 33, 38, 46, 51, 55, 60,
  21, 34, 37, 47, 50, 56, 59, 61,
  35, 36, 48, 49, 57, 58, 62, 63,
];

const STD_DC_LUMINANCE_NRCODES = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const STD_DC_LUMINANCE_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const STD_AC_LUMINANCE_NRCODES = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const STD_AC_LUMINANCE_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

const STD_DC_CHROMINANCE_NRCODES = [0, 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const STD_DC_CHROMINANCE_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const STD_AC_CHROMINANCE_NRCODES = [0, 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const STD_AC_CHROMINANCE_VALUES = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

type BitCode = { code: number; length: number };

class JpegEncoder {
  private YTable = new Int32Array(64);
  private UVTable = new Int32Array(64);
  private fdtbl_Y = new Float32Array(64);
  private fdtbl_UV = new Float32Array(64);
  private YDC_HT!: BitCode[];
  private UVDC_HT!: BitCode[];
  private YAC_HT!: BitCode[];
  private UVAC_HT!: BitCode[];
  private bitcode: BitCode[] = new Array(65535);
  private category = new Int32Array(65535);
  private outputfDCTQuant = new Float32Array(64);
  private DU = new Int32Array(64);

  // RGB->YUV lookup tables
  private RGB_YUV_TABLE = new Int32Array(2048);

  private byteout: number[] = [];
  private bytenew = 0;
  private bytepos = 7;

  constructor(quality: number) {
    this.initHuffmanTbl();
    this.initCategoryNumber();
    this.initRGBYUVTable();
    this.setQuality(quality);
  }

  private initQuantTables(sf: number) {
    const YQT = [
      16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69,
      56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81,
      104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
    ];
    for (let i = 0; i < 64; i++) {
      let t = Math.floor((YQT[i] * sf + 50) / 100);
      if (t < 1) t = 1;
      else if (t > 255) t = 255;
      this.YTable[ZIGZAG[i]] = t;
    }
    const UVQT = [
      17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99,
      99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
      99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
    ];
    for (let j = 0; j < 64; j++) {
      let u = Math.floor((UVQT[j] * sf + 50) / 100);
      if (u < 1) u = 1;
      else if (u > 255) u = 255;
      this.UVTable[ZIGZAG[j]] = u;
    }
    const aasf = [
      1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.5411961, 0.275899379,
    ];
    let k = 0;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        this.fdtbl_Y[k] = 1.0 / (this.YTable[ZIGZAG[k]] * aasf[row] * aasf[col] * 8.0);
        this.fdtbl_UV[k] = 1.0 / (this.UVTable[ZIGZAG[k]] * aasf[row] * aasf[col] * 8.0);
        k++;
      }
    }
  }

  private computeHuffmanTbl(nrcodes: number[], std_table: number[]): BitCode[] {
    let codevalue = 0;
    let pos_in_table = 0;
    const HT: BitCode[] = [];
    for (let k = 1; k <= 16; k++) {
      for (let j = 1; j <= nrcodes[k]; j++) {
        HT[std_table[pos_in_table]] = { code: codevalue, length: k };
        pos_in_table++;
        codevalue++;
      }
      codevalue *= 2;
    }
    return HT;
  }

  private initHuffmanTbl() {
    this.YDC_HT = this.computeHuffmanTbl(STD_DC_LUMINANCE_NRCODES, STD_DC_LUMINANCE_VALUES);
    this.UVDC_HT = this.computeHuffmanTbl(STD_DC_CHROMINANCE_NRCODES, STD_DC_CHROMINANCE_VALUES);
    this.YAC_HT = this.computeHuffmanTbl(STD_AC_LUMINANCE_NRCODES, STD_AC_LUMINANCE_VALUES);
    this.UVAC_HT = this.computeHuffmanTbl(STD_AC_CHROMINANCE_NRCODES, STD_AC_CHROMINANCE_VALUES);
  }

  private initCategoryNumber() {
    let nrlower = 1;
    let nrupper = 2;
    for (let cat = 1; cat <= 15; cat++) {
      for (let nr = nrlower; nr < nrupper; nr++) {
        this.category[32767 + nr] = cat;
        this.bitcode[32767 + nr] = { length: cat, code: nr };
      }
      for (let nrneg = -(nrupper - 1); nrneg <= -nrlower; nrneg++) {
        this.category[32767 + nrneg] = cat;
        this.bitcode[32767 + nrneg] = { length: cat, code: nrupper - 1 + nrneg };
      }
      nrlower <<= 1;
      nrupper <<= 1;
    }
  }

  private initRGBYUVTable() {
    for (let i = 0; i < 256; i++) {
      this.RGB_YUV_TABLE[i] = 19595 * i;
      this.RGB_YUV_TABLE[(i + 256) >> 0] = 38470 * i;
      this.RGB_YUV_TABLE[(i + 512) >> 0] = 7471 * i + 0x8000;
      this.RGB_YUV_TABLE[(i + 768) >> 0] = -11059 * i;
      this.RGB_YUV_TABLE[(i + 1024) >> 0] = -21709 * i;
      this.RGB_YUV_TABLE[(i + 1280) >> 0] = 32768 * i + 0x807fff;
      this.RGB_YUV_TABLE[(i + 1536) >> 0] = -27439 * i;
      this.RGB_YUV_TABLE[(i + 1792) >> 0] = -5329 * i;
    }
  }

  setQuality(quality: number) {
    let q = quality;
    if (q <= 0) q = 1;
    if (q > 100) q = 100;
    const sf = q < 50 ? Math.floor(5000 / q) : Math.floor(200 - q * 2);
    this.initQuantTables(sf);
  }

  private writeBits(bs: BitCode) {
    const value = bs.code;
    let posval = bs.length - 1;
    while (posval >= 0) {
      if (value & (1 << posval)) {
        this.bytenew |= 1 << this.bytepos;
      }
      posval--;
      this.bytepos--;
      if (this.bytepos < 0) {
        if (this.bytenew === 0xff) {
          this.writeByte(0xff);
          this.writeByte(0);
        } else {
          this.writeByte(this.bytenew);
        }
        this.bytepos = 7;
        this.bytenew = 0;
      }
    }
  }

  private writeByte(value: number) {
    this.byteout.push(value & 0xff);
  }

  private writeWord(value: number) {
    this.writeByte((value >> 8) & 0xff);
    this.writeByte(value & 0xff);
  }

  private fDCTQuant(data: Float32Array, fdtbl: Float32Array): Int32Array {
    let d0, d1, d2, d3, d4, d5, d6, d7;
    let dataOff = 0;
    const I8 = 8;
    const I64 = 64;
    for (let i = 0; i < I8; ++i) {
      d0 = data[dataOff];
      d1 = data[dataOff + 1];
      d2 = data[dataOff + 2];
      d3 = data[dataOff + 3];
      d4 = data[dataOff + 4];
      d5 = data[dataOff + 5];
      d6 = data[dataOff + 6];
      d7 = data[dataOff + 7];

      const tmp0 = d0 + d7;
      const tmp7 = d0 - d7;
      const tmp1 = d1 + d6;
      const tmp6 = d1 - d6;
      const tmp2 = d2 + d5;
      const tmp5 = d2 - d5;
      const tmp3 = d3 + d4;
      const tmp4 = d3 - d4;

      let tmp10 = tmp0 + tmp3;
      const tmp13 = tmp0 - tmp3;
      let tmp11 = tmp1 + tmp2;
      let tmp12 = tmp1 - tmp2;

      data[dataOff] = tmp10 + tmp11;
      data[dataOff + 4] = tmp10 - tmp11;

      const z1 = (tmp12 + tmp13) * 0.707106781;
      data[dataOff + 2] = tmp13 + z1;
      data[dataOff + 6] = tmp13 - z1;

      tmp10 = tmp4 + tmp5;
      tmp11 = tmp5 + tmp6;
      tmp12 = tmp6 + tmp7;

      const z5 = (tmp10 - tmp12) * 0.382683433;
      const z2 = 0.5411961 * tmp10 + z5;
      const z4 = 1.306562965 * tmp12 + z5;
      const z3 = tmp11 * 0.707106781;

      const z11 = tmp7 + z3;
      const z13 = tmp7 - z3;

      data[dataOff + 5] = z13 + z2;
      data[dataOff + 3] = z13 - z2;
      data[dataOff + 1] = z11 + z4;
      data[dataOff + 7] = z11 - z4;

      dataOff += 8;
    }

    dataOff = 0;
    for (let i = 0; i < I8; ++i) {
      d0 = data[dataOff];
      d1 = data[dataOff + 8];
      d2 = data[dataOff + 16];
      d3 = data[dataOff + 24];
      d4 = data[dataOff + 32];
      d5 = data[dataOff + 40];
      d6 = data[dataOff + 48];
      d7 = data[dataOff + 56];

      const tmp0p2 = d0 + d7;
      const tmp7p2 = d0 - d7;
      const tmp1p2 = d1 + d6;
      const tmp6p2 = d1 - d6;
      const tmp2p2 = d2 + d5;
      const tmp5p2 = d2 - d5;
      const tmp3p2 = d3 + d4;
      const tmp4p2 = d3 - d4;

      let tmp10p2 = tmp0p2 + tmp3p2;
      const tmp13p2 = tmp0p2 - tmp3p2;
      let tmp11p2 = tmp1p2 + tmp2p2;
      let tmp12p2 = tmp1p2 - tmp2p2;

      data[dataOff] = tmp10p2 + tmp11p2;
      data[dataOff + 32] = tmp10p2 - tmp11p2;

      const z1p2 = (tmp12p2 + tmp13p2) * 0.707106781;
      data[dataOff + 16] = tmp13p2 + z1p2;
      data[dataOff + 48] = tmp13p2 - z1p2;

      tmp10p2 = tmp4p2 + tmp5p2;
      tmp11p2 = tmp5p2 + tmp6p2;
      tmp12p2 = tmp6p2 + tmp7p2;

      const z5p2 = (tmp10p2 - tmp12p2) * 0.382683433;
      const z2p2 = 0.5411961 * tmp10p2 + z5p2;
      const z4p2 = 1.306562965 * tmp12p2 + z5p2;
      const z3p2 = tmp11p2 * 0.707106781;

      const z11p2 = tmp7p2 + z3p2;
      const z13p2 = tmp7p2 - z3p2;

      data[dataOff + 40] = z13p2 + z2p2;
      data[dataOff + 24] = z13p2 - z2p2;
      data[dataOff + 8] = z11p2 + z4p2;
      data[dataOff + 56] = z11p2 - z4p2;

      dataOff++;
    }

    for (let i = 0; i < I64; ++i) {
      const fDCTVal = data[i] * fdtbl[i];
      this.outputfDCTQuant[i] = fDCTVal > 0.0 ? (fDCTVal + 0.5) | 0 : (fDCTVal - 0.5) | 0;
    }
    return this.outputfDCTQuant as unknown as Int32Array;
  }

  private processDU(
    CDU: Float32Array,
    fdtbl: Float32Array,
    DC: number,
    HTDC: BitCode[],
    HTAC: BitCode[],
  ): number {
    const EOB = HTAC[0x00];
    const M16zeroes = HTAC[0xf0];
    let pos;
    const I16 = 16;
    const I63 = 63;
    const I64 = 64;
    const DU_DCT = this.fDCTQuant(CDU, fdtbl);
    for (let j = 0; j < I64; ++j) {
      this.DU[ZIGZAG[j]] = DU_DCT[j];
    }
    const Diff = this.DU[0] - DC;
    DC = this.DU[0];
    if (Diff === 0) {
      this.writeBits(HTDC[0]);
    } else {
      pos = 32767 + Diff;
      this.writeBits(HTDC[this.category[pos]]);
      this.writeBits(this.bitcode[pos]);
    }
    let end0pos = 63;
    for (; end0pos > 0 && this.DU[end0pos] === 0; end0pos--) {}
    if (end0pos === 0) {
      this.writeBits(EOB);
      return DC;
    }
    let i = 1;
    let lng;
    while (i <= end0pos) {
      const startpos = i;
      for (; this.DU[i] === 0 && i <= end0pos; ++i) {}
      let nrzeroes = i - startpos;
      if (nrzeroes >= I16) {
        lng = nrzeroes >> 4;
        for (let nrmarker = 1; nrmarker <= lng; ++nrmarker) this.writeBits(M16zeroes);
        nrzeroes = nrzeroes & 0xf;
      }
      pos = 32767 + this.DU[i];
      this.writeBits(HTAC[(nrzeroes << 4) + this.category[pos]]);
      this.writeBits(this.bitcode[pos]);
      i++;
    }
    if (end0pos !== I63) {
      this.writeBits(EOB);
    }
    return DC;
  }

  encode(rgba: Buffer, width: number, height: number): Buffer {
    this.byteout = [];
    this.bytenew = 0;
    this.bytepos = 7;

    // Headers
    this.writeWord(0xffd8); // SOI
    // APP0/JFIF
    this.writeWord(0xffe0);
    this.writeWord(16);
    this.writeByte(0x4a);
    this.writeByte(0x46);
    this.writeByte(0x49);
    this.writeByte(0x46);
    this.writeByte(0);
    this.writeByte(1);
    this.writeByte(1);
    this.writeByte(0);
    this.writeWord(1);
    this.writeWord(1);
    this.writeByte(0);
    this.writeByte(0);
    // DQT
    this.writeWord(0xffdb);
    this.writeWord(132);
    this.writeByte(0);
    for (let i = 0; i < 64; i++) this.writeByte(this.YTable[i]);
    this.writeByte(1);
    for (let j = 0; j < 64; j++) this.writeByte(this.UVTable[j]);
    // SOF0
    this.writeWord(0xffc0);
    this.writeWord(17);
    this.writeByte(8);
    this.writeWord(height);
    this.writeWord(width);
    this.writeByte(3);
    this.writeByte(1);
    this.writeByte(0x11);
    this.writeByte(0);
    this.writeByte(2);
    this.writeByte(0x11);
    this.writeByte(1);
    this.writeByte(3);
    this.writeByte(0x11);
    this.writeByte(1);
    // DHT
    this.writeWord(0xffc4);
    this.writeWord(0x01a2);
    this.writeByte(0);
    for (let i = 0; i < 16; i++) this.writeByte(STD_DC_LUMINANCE_NRCODES[i + 1]);
    for (let i = 0; i <= 11; i++) this.writeByte(STD_DC_LUMINANCE_VALUES[i]);
    this.writeByte(0x10);
    for (let i = 0; i < 16; i++) this.writeByte(STD_AC_LUMINANCE_NRCODES[i + 1]);
    for (let i = 0; i <= 161; i++) this.writeByte(STD_AC_LUMINANCE_VALUES[i]);
    this.writeByte(1);
    for (let i = 0; i < 16; i++) this.writeByte(STD_DC_CHROMINANCE_NRCODES[i + 1]);
    for (let i = 0; i <= 11; i++) this.writeByte(STD_DC_CHROMINANCE_VALUES[i]);
    this.writeByte(0x11);
    for (let i = 0; i < 16; i++) this.writeByte(STD_AC_CHROMINANCE_NRCODES[i + 1]);
    for (let i = 0; i <= 161; i++) this.writeByte(STD_AC_CHROMINANCE_VALUES[i]);
    // SOS
    this.writeWord(0xffda);
    this.writeWord(12);
    this.writeByte(3);
    this.writeByte(1);
    this.writeByte(0);
    this.writeByte(2);
    this.writeByte(0x11);
    this.writeByte(3);
    this.writeByte(0x11);
    this.writeByte(0);
    this.writeByte(0x3f);
    this.writeByte(0);

    // Encode 8x8 macroblocks
    let DCY = 0;
    let DCU = 0;
    let DCV = 0;
    this.bytenew = 0;
    this.bytepos = 7;

    const YDU = new Float32Array(64);
    const UDU = new Float32Array(64);
    const VDU = new Float32Array(64);
    const quadWidth = width * 4;
    const fdtbl_Y = this.fdtbl_Y;
    const fdtbl_UV = this.fdtbl_UV;
    const RGB_YUV_TABLE = this.RGB_YUV_TABLE;

    for (let y = 0; y < height; y += 8) {
      for (let x = 0; x < width; x += 8) {
        let start = quadWidth * y + x * 4;
        for (let pos = 0; pos < 64; pos++) {
          const row = pos >> 3;
          const col = (pos & 7) * 4;
          let p = start + row * quadWidth + col;
          // Clamp to edges for non-multiple-of-8 dimensions.
          if (y + row >= height) p -= quadWidth * (y + row - height + 1);
          if (x + (col >> 2) >= width) p -= 4 * (x + (col >> 2) - width + 1);

          const r = rgba[p];
          const g = rgba[p + 1];
          const b = rgba[p + 2];

          YDU[pos] =
            ((RGB_YUV_TABLE[r] + RGB_YUV_TABLE[g + 256] + RGB_YUV_TABLE[b + 512]) >> 16) - 128;
          UDU[pos] =
            ((RGB_YUV_TABLE[r + 768] + RGB_YUV_TABLE[g + 1024] + RGB_YUV_TABLE[b + 1280]) >> 16) -
            128;
          VDU[pos] =
            ((RGB_YUV_TABLE[r + 1280] + RGB_YUV_TABLE[g + 1536] + RGB_YUV_TABLE[b + 1792]) >> 16) -
            128;
        }

        DCY = this.processDU(YDU, fdtbl_Y, DCY, this.YDC_HT, this.YAC_HT);
        DCU = this.processDU(UDU, fdtbl_UV, DCU, this.UVDC_HT, this.UVAC_HT);
        DCV = this.processDU(VDU, fdtbl_UV, DCV, this.UVDC_HT, this.UVAC_HT);
      }
    }

    // Flush remaining bits
    if (this.bytepos >= 0) {
      const fillbits: BitCode = { length: this.bytepos + 1, code: (1 << (this.bytepos + 1)) - 1 };
      this.writeBits(fillbits);
    }
    this.writeWord(0xffd9); // EOI

    return Buffer.from(this.byteout);
  }
}

export function rgbaToJpeg(rgba: Buffer, width: number, height: number, quality = 80): Buffer {
  if (width <= 0 || height <= 0) throw new Error(`Invalid JPEG dimensions: ${width}x${height}`);
  const expected = width * height * 4;
  if (rgba.length < expected) throw new Error(`Buffer too small: got ${rgba.length}, need ${expected}`);
  const encoder = new JpegEncoder(quality);
  return encoder.encode(rgba, width, height);
}
