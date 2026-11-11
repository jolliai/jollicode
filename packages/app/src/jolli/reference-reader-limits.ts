/**
 * How much of a material the reader draws in a browser tab.
 *
 * Constants, not settings: they protect a tab, not a server, and nothing about them varies by
 * institution. A file past a limit is still whole in storage and one Download away.
 */

/**
 * The most of a text or markdown file the reader reads and draws: 5 MB.
 *
 * Past a few megabytes a single text node or markdown tree makes the tab stutter, and nobody reads
 * that much online. The first 5 MB is shown, with a line saying the rest is in the download.
 */
export const READER_TEXT_BYTES = 5 * 1024 * 1024

/**
 * The most lines of a plain text file the reader draws: 20,000.
 *
 * The byte limit does not bound the page, because the viewer draws every line as three elements —
 * the row, its number and its text. 5 MB of a log's 20-character lines is about 250,000 lines, some
 * 750,000 elements laid out at once; 20,000 lines is 60,000. The limit was set, not measured. Past
 * it the first 20,000 lines are shown, with a line saying the rest is in the download.
 */
export const READER_TEXT_LINES = 20_000

/**
 * The most CSV rows the reader draws as a table: 5,000.
 *
 * A DOM table past that is slow to scroll. Everything read is still parsed, so for a file within
 * `READER_CSV_BYTES` the "of N rows" it states is true.
 */
export const READER_CSV_ROWS = 5000

/**
 * The most of a CSV file the reader reads and parses: 10 MB.
 *
 * The row limit bounds only what is drawn; this bounds what is held. Parsing holds every field as a
 * string, about eight times the file's size: a 10 MB file of 140,000 rows parsed in about 100 ms and
 * took about 80 MB of heap on a laptop (Node 26, measured for this limit), so a 100 MB upload would
 * take most of a gigabyte, all on the main thread. Past the limit only the first 10 MB is read, and
 * the reader says the rest is in the download instead of how many rows there are.
 */
export const READER_CSV_BYTES = 10 * 1024 * 1024

/**
 * The largest `.docx` the reader renders: 40 MB.
 *
 * The Word renderer holds the whole package, and every picture in it, in memory at once. The largest
 * real course document measured — a 9.2 MB syllabus with fifteen photographs — rendered in 98 ms, so
 * this sits well above real documents rather than at the edge of what a tab survives.
 */
export const READER_DOCX_BYTES = 40 * 1024 * 1024

/**
 * The most a `.docx` package may expand to before it is unzipped or rendered: 64 MB.
 *
 * Unlike a workbook, a Word document is unzipped and drawn on the page's own thread, and the
 * renderer parses its XML in one synchronous step, so this bounds how long the window can stall as
 * well as the memory it takes. Pictures are stored already compressed and expand to about their own
 * size, so a document of photographs within `READER_DOCX_BYTES` fits; text expands about ten times,
 * so this still holds a document of well over a thousand pages. Set, not measured.
 */
export const READER_DOCX_INFLATED_BYTES = 64 * 1024 * 1024

/**
 * The most parts a `.docx` package may hold: 2,000. A document is a few dozen parts plus one per
 * picture; the directory is walked, and every part opened, before anything is drawn.
 */
export const READER_DOCX_ENTRIES = 2000

/** Excel packages need the whole file. Parsing is isolated in a worker and capped separately. */
export const READER_EXCEL_BYTES = 10 * 1024 * 1024
/**
 * The most a workbook package may expand to before its parser is handed it. A worker shares the
 * page's process, so this, not the deadline, is what keeps a zip bomb from taking the tab down.
 * Gradebooks and timetables expand to a few megabytes.
 */
export const READER_EXCEL_INFLATED_BYTES = 100 * 1024 * 1024
/** The most parts a workbook package may hold: a few per sheet, so far beyond any real workbook. */
export const READER_EXCEL_ENTRIES = 10_000
/** Bounds one sheet's DOM, including its empty cells, to 50,000 cells: row positions from the sheet's first, and visible columns. */
export const READER_EXCEL_ROWS = 1000
export const READER_EXCEL_COLUMNS = 50
/** Bounds the text transferred from the worker and held by one sheet's table. */
export const READER_EXCEL_CHARS = 2_000_000
export const READER_EXCEL_CELL_CHARS = 10_000
/** How many sheets' display cells the worker keeps for going back to, each up to `READER_EXCEL_CHARS`. */
export const READER_EXCEL_CACHED_SHEETS = 8
/** Terminate a parser that cannot finish one request, counted from when its worker is listening. */
export const READER_EXCEL_TIMEOUT_MS = 20_000
/**
 * How long the worker's own script may take to load and start. Apart from the request deadline,
 * because on a slow connection the parser's script alone takes a good part of that.
 */
export const READER_EXCEL_START_TIMEOUT_MS = 60_000
