/**
 * ONE-WAY FIXUPS FOR THE PERSISTED LAYOUT STORE.
 *
 * ⚠ SEPARATE FROM `layout.tsx` SO THEY CAN BE TESTED WITHOUT MOUNTING A PROVIDER, which is the same
 * reason `tab-migration.ts` sits next to `tabs.tsx`. A store migration runs at most once per
 * install and is then unobservable forever, so a mistake in one is found by a student rather than
 * by a test run — that asymmetry is what earns it its own module.
 *
 * ⚠ EVERY FUNCTION HERE RETURNS ITS ARGUMENT BY REFERENCE WHEN IT CHANGES NOTHING. `layout.tsx`
 * decides whether to write anything back by comparing identity (`migrated === original`), so
 * returning a fresh-but-equal object would make every launch a write.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The persisted `sidebar` slice, brought up to the current shape.
 *
 * Two independent fixups, applied in order:
 *
 * 1. `workspaces` used to be a single boolean for the whole sidebar; it is now a per-directory map
 *    with that boolean preserved as the default.
 * 2. `opened` is forced true once — see the comment on the `railMigrated` branch below.
 */
export function migrateSidebar(sidebar: unknown): unknown {
  if (!isRecord(sidebar)) return sidebar

  const withWorkspaces =
    typeof sidebar.workspaces === "boolean"
      ? { ...sidebar, workspaces: {}, workspacesDefault: sidebar.workspaces }
      : sidebar

  /**
   * OPEN THE SIDEBAR ONCE, FOR EVERY INSTALL THAT PREDATES IT BEING THE NAVIGATION.
   *
   * ⚠ FLIPPING THE DEFAULT IS NOT ENOUGH, WHICH IS THE WHOLE REASON THIS BRANCH EXISTS. `opened`
   * has been persisted as `false` since before there was a sidebar worth opening — the rail was an
   * optional extra beside the titlebar's tab strip. It is now the only way to reach a session, so
   * an upgrading student would launch into an app with no navigation at all and no reason to
   * suspect a hidden panel.
   *
   * ⚠ AND IT IS LATCHED ON ITS OWN FLAG RATHER THAN ON `opened`. Reading `opened` cannot tell
   * "never migrated" from "migrated, then deliberately closed", so a migration keyed on it would
   * reopen the sidebar on every launch and the close button would look broken. The flag is also
   * `true` in the default store shape, so a fresh install is never mistaken on its second launch
   * for an install that predates the sidebar.
   */
  if (typeof withWorkspaces.railMigrated === "boolean") return withWorkspaces
  return { ...withWorkspaces, opened: true, railMigrated: true }
}
