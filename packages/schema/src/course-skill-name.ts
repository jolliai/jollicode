export * as CourseSkillName from "./course-skill-name"

/** Reserved for skills supplied by a course assistant. */
export const PREFIX = "course:"
export const nameOf = (command: string) => `${PREFIX}${command}`
export const isCourse = (name: string) => name.startsWith(PREFIX)
