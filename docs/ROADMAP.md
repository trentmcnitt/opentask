# OpenTask Roadmap

Ideas and features under consideration. Nothing here is committed — items move to GitHub issues when they're ready for implementation.

## Under Consideration

### Project Icons

Add an emoji or icon to each project, displayed in the project list and task grouping headers. Could be a simple emoji column on the projects table with a picker in project settings.

### Per-Project Notification Grouping

Group notifications by project so each project gets its own notification stack on iOS. Web Push on iOS doesn't support `tag`-based replacement (open WebKit bug), but a future native iOS app could use `thread-id` for proper grouping. Needs investigation into the best approach given current platform constraints.
