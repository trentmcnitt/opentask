# OpenTask Roadmap

Ideas and features under consideration. Nothing here is committed — items move to GitHub issues when they're ready for implementation.

## Under Consideration

### Project Icons

Add an emoji or icon to each project, displayed in the project list and task grouping headers. Could be a simple emoji column on the projects table with a picker in project settings.

### Per-Project Notification Topics

Allow each project to send notifications to a different ntfy topic. This would give each project its own notification stack on iOS (ntfy groups by topic). Needs investigation into:

- Whether ntfy topic-per-project achieves the desired UX on iOS (separate notification groups)
- How to handle the default/fallback topic for projects without a custom one
- Whether users would need to subscribe to each topic individually in the ntfy app
- UI for configuring topic per project
