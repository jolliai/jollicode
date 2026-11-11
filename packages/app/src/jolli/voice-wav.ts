/** Average input samples into a bounded 16 kHz mono PCM WAV. */
export function voiceWav(chunks: readonly Float32Array[], inputRate: number) {
  const inputLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const input = new Float32Array(inputLength)
  let position = 0
  for (const chunk of chunks) {
    input.set(chunk, position)
    position += chunk.length
  }
  const length = Math.min(120 * 16000, Math.floor((input.length * 16000) / inputRate))
  const buffer = new ArrayBuffer(44 + length * 2)
  const view = new DataView(buffer)
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  text(0, "RIFF")
  view.setUint32(4, 36 + length * 2, true)
  text(8, "WAVE")
  text(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, "data")
  view.setUint32(40, length * 2, true)
  for (let i = 0; i < length; i++) {
    const start = Math.floor((i * inputRate) / 16000)
    const end = Math.min(input.length, Math.max(start + 1, Math.floor(((i + 1) * inputRate) / 16000)))
    let total = 0
    for (let j = start; j < end; j++) total += input[j]
    const sample = Math.max(-1, Math.min(1, total / (end - start)))
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true)
  }
  return new Blob([buffer], { type: "audio/wav" })
}
