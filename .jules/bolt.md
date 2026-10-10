# Bolt's Journal

Critical learnings only. Do not log routine optimizations.

## 2026-10-10 - PNG Chunk Buffer Pre-allocation vs Deflate Compression
**Learning:** In image encoders like `rgbaToPng`, attempting to optimize chunk allocations (`Buffer.allocUnsafe`, single chunk buffer layout, avoiding `Buffer.concat` before CRC calculation) yielded negligible performance improvement (-3% to 0% delta). Profiling demonstrated that synchronous zlib deflation (`deflateSync`) consumes over 95% of total runtime, completely dwarfing buffer allocation overhead.
**Action:** In data pipelines involving compression or encryption (zlib, crypto), always profile the compression step before attempting memory allocation or chunk-packing optimizations.
