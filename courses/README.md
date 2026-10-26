# Courses

Course files written outside Hodos, for example by Claude Code with the
`hodos-course` skill (`.claude/skills/hodos-course`). Each file is one
course in the format `pnpm exec hodos course guide` describes.

    pnpm exec hodos course validate courses/<id>.json
    pnpm exec hodos course submit courses/<id>.json
    pnpm exec hodos course status

A submitted course becomes a draft in the Hodos workspace and reaches
learners only after it is approved there. See
[docs/course-authoring.md](../docs/course-authoring.md).
