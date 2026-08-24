# Manual menu inbox

When the Facebook importer breaks, a repository collaborator can upload the
public menu image here using a filename such as `2026-08-24.png`. The manual
import workflow validates the date in the filename, extracts and verifies the
menu, and publishes only a fully validated result.

Image files are intentionally ignored by local Git. The GitHub workflow handles
them from the triggering commit and does not include them in the deployed site.
