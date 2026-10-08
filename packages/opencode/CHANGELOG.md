# Jolli Code CLI changelog

<!-- Each release adds a `## MAJOR.MINOR.PATCH` section at the top. The release workflow publishes the top section's version, with that section as the release notes. -->

## 0.0.3

- **Contact support from the crash screen.** If the terminal UI crashes, copy the crash report (version, OS, terminal, error message and stack trace) and email it to support@jolli.ai. The crash screen tells you when copying fails.
- Bug fixes.

## 0.0.1

The first release of the Jolli Code CLI, an AI coding assistant for your courses.

- **Sign in with your Jolli account.** Run `/login` once. The CLI, the terminal UI and the desktop app share the same sign-in.
- **Chat inside a course.** Pick a course and one of its assistants, and choose from the models your course provides. The course and model stay fixed once a chat starts, and the composer shows which course and assistant you are using.
- **Course materials at hand.** The assistant can search and read your course's materials and the files you attached.
- **Keeps going when a model is unavailable.** Jolli Code moves your chat to a backup model, and asks you first when needed.
- **Project settings** live in `jollicode.json` and the `.jollicode/` folder.
- Install with `npm install -g @jolli.ai/jollicode`.
