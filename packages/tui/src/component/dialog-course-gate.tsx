import { createEffect, createMemo } from "solid-js"
import { useJolli } from "../context/jolli"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { DialogLogout } from "./dialog-logout"

/**
 * SIGNED IN, AND ENROLLED IN NOTHING THIS PRODUCT RUNS.
 *
 * ⚠ IT IS THE DESKTOP'S COURSE GATE, WORD FOR WORD AND ACTION FOR ACTION. That surface stops a
 * student here rather than opening onto an empty picker, and offers exactly two ways forward:
 * check again, or use a different account. A student who signed in with the wrong one — the
 * personal account instead of the university's — has no other route, and "you have no courses" with
 * no way to act on it is a dead end dressed as an explanation.
 *
 * ⚠ "USE A DIFFERENT ACCOUNT" IS SIGN-OUT, NOT A SECOND SIGN-IN. The picker refuses to re-run a
 * login for somebody who already holds a credential — see `connectAction` — so switching has to go
 * through dropping the one in hand. Signing out empties the provider list, which is what puts the
 * sign-in prompt back up.
 *
 * ⚠ AND IT SAYS WHICH OF THE TWO EMPTY ANSWERS THIS IS. "You have no courses" and "we could not
 * ask" arrive identically — an empty list — and the desktop's gate is emphatic that they must stay
 * apart: a dropped connection reported as "none of your courses use Jolli Code" sends a student to
 * their registrar over a Wi-Fi problem. `Jolli.CatalogStatus` is what carries the difference here.
 */
export function DialogCourseGate() {
  const jolli = useJolli()
  const dialog = useDialog()
  const unreachable = createMemo(() => jolli.unreachable())

  /**
   * ⚠ IT CLOSES ITSELF WHEN THE THING IT IS REPORTING STOPS BEING TRUE, AND LEAVING THAT OUT WAS A
   * BUG WORTH NAMING. This dialog is opened by an effect watching a condition, but a dialog is not
   * a view of that condition — once on screen it stays there. The catalogue is allowed to resolve
   * LATE: the first fetch can answer `unreachable` while the provider block is still being rebuilt
   * (see `modelsMissing`), and the retry that follows can come back with everything. That left a
   * student reading "none of your courses are open" over a composer that had already bound a
   * course and picked its model — the screen contradicting itself in two places at once.
   *
   * ⚠ AND IT CLEARS RATHER THAN RENDERING NOTHING, because this is the whole dialog. A `Show` that
   * went empty would leave an empty box on the stack with esc as the only way out.
   */
  createEffect(() => {
    if (jolli.noCourses() || unreachable()) return
    dialog.clear()
  })
  /**
   * ⚠ ENROLLED IN NOTHING AND ENROLLED IN NOTHING OPEN ARE DIFFERENT SENTENCES. Since this surface
   * does not list a course it would refuse, the second case reaches the gate too — and telling a
   * student whose term starts next week that none of their courses use this product would be the
   * same class of wrong answer as calling a missing tenant a connection problem.
   */
  const title = createMemo(() => {
    if (unreachable()) return "Couldn't reach Jolli"
    return jolli.enrolled() ? "No courses open yet" : "No Jolli Code courses"
  })
  const body = createMemo(() => {
    if (unreachable()) return "Jolli Code couldn't load your courses. Check your connection, then try again."
    return jolli.enrolled()
      ? "None of your courses are open in Jolli Code right now. Once your instructor publishes one, check again."
      : "None of your courses use Jolli Code yet. Once your instructor sets one up, check again."
  })

  const options = createMemo(() => [
    {
      value: "retry" as const,
      title: "Check again",
      description: "Ask Jolli for your courses again",
    },
    {
      value: "switch" as const,
      title: "Use a different account",
      description: "Sign out, then sign in as somebody else",
    },
  ])

  return (
    <DialogSelect
      title={title()}
      renderFilter={false}
      options={options()}
      footer={<text>{body()}</text>}
      onSelect={(option) => {
        if (option.value === "switch") return dialog.replace(() => <DialogLogout />)
        jolli.refresh()
        dialog.clear()
      }}
    />
  )
}
