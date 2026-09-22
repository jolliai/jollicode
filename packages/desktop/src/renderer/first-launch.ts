/**
 * WHETHER A FIRST LAUNCH OPENS THE DEFAULT PROJECT, OR LEAVES THE STUDENT STANDING AT AN EMPTY HOME.
 *
 * ⚠ EXTRACTED FROM `onboarding.tsx` SO IT CAN BE TESTED. The decision is two booleans and a string;
 * the component that used to hold it needs a renderer, a server context and a live tab registry to
 * exist at all, which is why the condition went five releases without anyone noticing it was wrong.
 */

export type FirstLaunchState = {
  /** Projects already registered for this server — `server.projects.list()`, after `server.ready`. */
  hasProjects: boolean
  /** The route this window restored to. `"/"` is where a window with no saved history lands. */
  initialUrl: string
  /** Entries in the tab registry, read after `tabs.ready` and `tabs.recentReady` have settled. */
  openTabs: number
}

/**
 * ⚠ THE SERVER LIST IS DELIBERATELY NOT A CONDITION HERE, AND IT USED TO BE. The rule was
 * `server.list.every(ServerConnection.builtin)`, which reads as "nothing but the bundled sidecar is
 * configured" — but that is not what it does on Windows. `readyWslConnections` contributes a
 * `variant: "wsl"` sidecar for every WSL distribution the machine happens to have, `builtin` accepts
 * only `variant: "base"`, so every Windows machine with WSL installed failed the check and dropped
 * its student onto an empty Home with nothing but an "Add project" button.
 *
 * ⚠ AND IT FAILED PERMANENTLY, WHICH IS THE PART THAT MADE IT WORTH DELETING RATHER THAN LOOSENING.
 * `finishFirstLaunchOnboarding` marks the onboarding complete whether or not it created anything, so
 * a default project missed on launch one is never offered again.
 *
 * What that condition was reaching for is already enforced by the caller, and more precisely:
 * `server.isLocal()` returns early — before the pending flag is consumed — unless the server the
 * draft would actually be opened on is the local sidecar. A WSL distribution merely EXISTING says
 * nothing about where that draft is going.
 */
export function shouldOpenDefaultProject(state: FirstLaunchState) {
  /**
   * ⚠ "ALREADY HAS A PROJECT", NOT "IS AN UPGRADE", AND THAT SWAP IS THE SECOND TIME THIS CONDITION
   * HAS BEEN WRONG IN THE SAME WAY. The rule was `existingInstall` — `isOldLayoutEligible` in the
   * main process — which is decided by `hasExistingAppState`: any `*.dat`, any `window-state-*.json`
   * or a `jollicode.settings` in the user-data directory. That is a test for "this profile has been
   * used before", not for "this student has somewhere to work, so they don't need a default project"
   * — and the two come apart in exactly the case this is for. A profile that has launched the app,
   * been signed out, or been used before the course gate existed carries all of that state while
   * carrying no projects at all, and its student lands on an empty Home being asked to add one.
   *
   * ⚠ THE REASON IT WAS WORTH REPLACING RATHER THAN WIDENING IS THAT THE PROJECT LIST IS THE FACT
   * THE DECISION IS ABOUT. `server.projects.list()` is what the sidebar renders and what
   * `home.project.newSession()` reads to decide whether a session can be started; keying on it means
   * "no project to work in" and "make one" cannot disagree. An upgrading student with projects is
   * still left alone, which is all `existingInstall` was ever reaching for.
   */
  if (state.hasProjects) return false
  /**
   * ⚠ BOTH OF THESE MEAN "THIS WINDOW ALREADY HAS SOMEWHERE TO BE". Neither can be true on a genuine
   * first launch, and both are cheap insurance against opening an unasked-for draft over restored
   * work if the pending flag is ever reached a second time.
   */
  if (state.initialUrl !== "/") return false
  return state.openTabs === 0
}
