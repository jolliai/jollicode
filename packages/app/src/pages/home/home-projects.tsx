import type { HomeProjectsController } from "./home-projects-controller"
import type { HomeProjectsViewProps } from "./home-projects-view"

/**
 * CONTROLLER TO VIEW PROPS, IN ONE PLACE.
 *
 * ⚠ THIS FILE USED TO BE A COMPONENT — `HomeProjects`, the adapter that threaded the controller into
 * the home page's `<aside>`. Both are gone: the sidebar renders the rows and owns the column. The
 * mapping stayed because the rows still take thirty props, and mapping them by hand at each call
 * site is thirty chances for two surfaces to disagree about which handler a row calls.
 *
 * ⚠ `onWheel` IS THE ONLY PARAMETER, because it is the only prop that belongs to the container
 * rather than to the projects. The sidebar is the outermost scroller on its side and passes a
 * no-op; a future embedding with an outer scroller hands over its wheel containment here.
 */
export function homeProjectsViewProps(
  projects: HomeProjectsController,
  onWheel: (event: WheelEvent) => void,
): HomeProjectsViewProps {
  return {
    language: projects.copy.language,
    servers: projects.server.list,
    projects: projects.project.list,
    recentlyClosed: projects.project.recentlyClosed,
    selection: projects.selection.value,
    homedir: projects.project.homedir,
    serverHealth: projects.server.health,
    projectsForServer: projects.server.projects,
    collapsed: projects.server.collapsed,
    canDefaultServer: projects.server.canDefault,
    defaultServerKey: projects.server.defaultKey,
    canRevealProject: projects.project.canReveal,
    unseenCount: projects.project.unseenCount,
    onWheel,
    onChooseProject: projects.project.choose,
    onFocusServer: projects.server.focus,
    onToggleCollapsed: projects.server.toggleCollapsed,
    onEditServer: projects.server.edit,
    onSetDefaultServer: projects.server.setDefault,
    onRemoveServer: projects.server.remove,
    onMoveProject: projects.project.move,
    onSelectProject: projects.project.select,
    onAddProjects: projects.project.add,
    onOpenProjectNewSession: projects.project.openNewSession,
    onEditProject: projects.project.edit,
    onRevealProject: projects.project.reveal,
    onClearNotifications: projects.project.clearNotifications,
    onCloseProject: projects.project.close,
    onOpenSettings: projects.utility.settings,
    onOpenHelp: projects.utility.help,
  }
}
