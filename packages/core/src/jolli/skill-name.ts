export * as CourseSkillName from "./skill-name"

/** Reserved for skills supplied by the session's course assistant. */
export const PREFIX = "course:"
export const nameOf = (command: string) => `${PREFIX}${command}`
export const isCourse = (name: string) => name.startsWith(PREFIX)
