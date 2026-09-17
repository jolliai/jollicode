import { TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import { useTheme } from "../context/theme"
import { logo } from "../logo"

export function Logo() {
  const { theme } = useTheme()

  const renderLine = (line: string) =>
    Array.from(line).map((char) => (
      <text fg={theme.text} attributes={TextAttributes.BOLD} selectable={false}>
        {char}
      </text>
    ))

  return (
    <box>
      <For each={logo}>{(line) => <box flexDirection="row">{renderLine(line)}</box>}</For>
    </box>
  )
}
