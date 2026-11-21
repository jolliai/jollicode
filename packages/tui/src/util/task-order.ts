/** Order copy follows the terminal's process locale; the TUI has no shared UI dictionary. */
export function taskOrderCopy(
  task: string,
  locale = process.env.LC_ALL ||
    process.env.LC_MESSAGES ||
    process.env.LANGUAGE ||
    process.env.LANG ||
    Intl.DateTimeFormat().resolvedOptions().locale,
) {
  if (locale.split(/[_.:@-]/)[0].toLowerCase() === "es")
    return {
      waiting: "En espera",
      submitFirst: `Envía primero ${task}`,
      optionalSubmitFirst: `Opcional · Envía primero ${task}`,
      refusal: `Los ejercicios de esta tarea se hacen en orden. Envía primero ${task}.`,
    }
  return {
    waiting: "Waiting",
    submitFirst: `Submit ${task} first`,
    optionalSubmitFirst: `Optional · Submit ${task} first`,
    refusal: `Tasks in this assignment go in order. Submit ${task} first.`,
  }
}
