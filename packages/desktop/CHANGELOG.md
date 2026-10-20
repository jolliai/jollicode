# Jolli Code Desktop changelog

<!-- Each release adds a `## MAJOR.MINOR.PATCH` section at the top. The release workflow publishes the top section's version, with that section as the release notes. -->

## 0.0.3

- **Windows and Linux installers.** The desktop app is available for Windows and Linux again, alongside macOS. Windows installers are signed.
- **Assignments.** TODO Assignments in the sidebar lists your course's assignments and their due dates. Open one to start or continue each task in its own chat, and turn the assignment in once every task is handed in. Tasks you do on the web are listed too.
- **Hand in from the chat.** In a task's chat, ask the assistant to hand in your work. It shows you exactly what it will hand in, and nothing is handed in until you approve.
- **Assignments link.** When you ask about assignments the assistant can't look up, the answer offers a View assignments button to your course's assignments page. A course material that belongs to an assignment links to it.
- **Assistants that open the conversation.** When a course assistant is set to speak first, press Start and the assistant writes the opening message.
- **Your teacher's brief** for an assistant shows above the composer before you start a chat.
- **Closed assistants.** When your teacher closes an assistant, you can still read the chat, and the app tells you it has closed. The course picker shows when no assistant is open right now.
- **Course skills.** A course assistant's skills show up as `/course:<name>` commands. The assistant loads one only when it needs it.
- **Sources under answers.** When your course shows citations, the course materials and web pages an answer draws on are listed under it.
- **OpenRouter models.** Models your course provides through OpenRouter now work, and are no longer listed under Anthropic.
- **Third-party licenses.** Help > Third-Party Licenses opens the license notices for the third-party code the app bundles.
- **Contact Support.** Help > Contact Support, the help buttons and the error page now open an email to support@jolli.ai.
- **Prompt history per chat.** Pressing Up in the composer recalls the prompts from the current chat only. A new chat starts with an empty history.
- **Translated course picker and share panel.** The course and assistant picker and the session share panel are now translated into every supported language.
- Bug fixes.

## 0.0.2

Bug fixes.

## 0.0.1

The first release of the Jolli Code desktop app, an AI coding assistant for your courses.

- **Sign in with your Jolli account.** The desktop app and the CLI share the same sign-in.
- **Chat inside a course.** Pick a course and one of its assistants, and choose from the models your course provides. The course and model stay fixed once a chat starts.
- **Course materials at hand.** The assistant can search and read your course's materials and the files you attached.
- **Share a session** with classmates, course staff or the whole class from the session header. Session titles show up on the Jolli website too.
- **Sessions in the sidebar.** Switch between sessions from the sidebar, and start a new one without picking a project first.
- **Keeps going when a model is unavailable.** Jolli Code moves your chat to a backup model, and asks you first when needed.
- **Windows:** install and run Jolli Code inside WSL from the app.
