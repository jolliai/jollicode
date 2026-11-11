/**
 * An RFC 4180 CSV parser, as much of one as a table viewer needs.
 *
 * Written here rather than taken as a dependency: quoted fields, doubled quotes, CR / LF / CRLF line
 * ends and a newline inside a quoted field are the whole of what a course spreadsheet exported from
 * Excel or Sheets uses, and a CSV library would be the heaviest part of the viewer it serves.
 *
 * Lenient where the RFC is strict, because a table that shows a slightly malformed file is more use
 * than one that refuses it: a quote in the middle of an unquoted field is kept as a character, text
 * after a closing quote is appended to the field, and an unterminated quote runs to the end of the
 * file. Rows may have different lengths; the viewer pads them.
 *
 * ⚠ THE SEPARATOR IS NOT ALWAYS A COMMA. Excel writes a CSV with the system's list separator, which
 * is a semicolon wherever the decimal separator is a comma (most of Europe, Russia, Brazil), and a
 * tab-separated export is often saved as `.csv`. Read with commas, such a file is one column holding
 * each whole line, with nothing to say so — so the separator is found first; see
 * {@link csvDelimiter}.
 */

/** The separators a spreadsheet actually writes, in the order a tie is settled. */
const DELIMITERS: ReadonlyArray<string> = [",", ";", "\t"]

/** How many records the separator is counted over: enough to outvote one odd header. */
const SNIFFED_RECORDS = 10

/** Excel's own first-line directive naming the separator, as `sep=;`. */
const SEP_DIRECTIVE = /^sep=(.)(?:\r\n|\r|\n|$)/

/**
 * The separator `text` uses, and where its records start.
 *
 * A first line `sep=X` — which Excel writes, and honours when it opens a file — names it outright,
 * and is not a record. Otherwise it is whichever of comma, semicolon and tab occurs most often
 * outside quotes over the first few records, a comma winning a tie and standing when none occurs:
 * a one-column file has no separator to find.
 */
export function csvDelimiter(text: string): { delimiter: string; start: number } {
  const directive = SEP_DIRECTIVE.exec(text)
  if (directive !== null) {
    return { delimiter: directive[1], start: directive[0].length }
  }
  const counts = new Map(DELIMITERS.map((delimiter) => [delimiter, 0]))
  let inQuotes = false
  let records = 0
  for (let index = 0; index < text.length && records < SNIFFED_RECORDS; index++) {
    const character = text[index]
    if (character === '"') {
      inQuotes = !inQuotes
      continue
    }
    // A separator or line end inside quotes is part of a field.
    if (inQuotes) continue
    if (character === "\n" || (character === "\r" && text[index + 1] !== "\n")) {
      records++
      continue
    }
    const count = counts.get(character)
    if (count !== undefined) counts.set(character, count + 1)
  }
  let delimiter = ","
  for (const candidate of DELIMITERS) {
    if ((counts.get(candidate) ?? 0) > (counts.get(delimiter) ?? 0)) {
      delimiter = candidate
    }
  }
  return { delimiter, start: 0 }
}

/**
 * The records in `text`, each a list of fields, split on the separator {@link csvDelimiter} finds.
 *
 * A trailing line end does not make an empty last record, and neither does an empty input.
 */
export function parseCsv(text: string): Array<Array<string>> {
  const records: Array<Array<string>> = []
  let record: Array<string> = []
  let field = ""
  let inQuotes = false
  // Whether anything has been read into the current record — so a trailing newline, which
  // leaves an untouched record behind it, adds no empty row.
  let recordStarted = false
  const separator = csvDelimiter(text)

  function endField(): void {
    record.push(field)
    field = ""
  }

  function endRecord(): void {
    endField()
    records.push(record)
    record = []
    recordStarted = false
  }

  for (let index = separator.start; index < text.length; index++) {
    const character = text[index]
    if (inQuotes && character !== '"') {
      field += character
      continue
    }
    if (inQuotes && text[index + 1] === '"') {
      // A doubled quote inside quotes is one literal quote.
      field += '"'
      index++
      continue
    }
    if (inQuotes) {
      inQuotes = false
      continue
    }
    if (character === '"' && field === "") {
      inQuotes = true
      recordStarted = true
      continue
    }
    if (character === separator.delimiter) {
      endField()
      recordStarted = true
      continue
    }
    if (character === "\r" || character === "\n") {
      endRecord()
      // CRLF is one line end, not two.
      if (character === "\r" && text[index + 1] === "\n") index++
      continue
    }
    field += character
    recordStarted = true
  }
  if (recordStarted || field !== "" || record.length > 0) {
    endRecord()
  }
  return records
}
