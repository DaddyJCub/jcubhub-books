# GitHub Actions Docker Setup

## Setup Instructions

1. **Create the workflows directory:**
   ```bash
   mkdir -p .github/workflows
   ```

2. **Move the workflow file:**
   ```bash
   mv docker-publish.yml .github/workflows/
   ```

3. **Enable GitHub Container Registry:**
   - Go to your GitHub repository settings
   - Navigate to "Actions" → "General"
   - Scroll to "Workflow permissions"
   - Ensure "Read and write permissions" is selected
   - Click "Save"

4. **Make your package public (for easy Unraid access):**
   - After the first workflow run, go to your GitHub profile
   - Click "Packages" tab
   - Find your repository package
   - Click on it → "Package settings"
   - Scroll down and click "Change visibility" → "Public"

## Using on Unraid

Once the workflow runs successfully, you can pull your image on Unraid:

```bash
docker pull ghcr.io/YOUR_USERNAME/YOUR_REPO:latest
```

Replace `YOUR_USERNAME/YOUR_REPO` with your actual GitHub username and repository name.

### Example Docker Run Command for Unraid:

```bash
docker run -d \
  --name jcubhub-books \
  -p 3003:3003 \
  -v /mnt/user/appdata/jcubhub-books/data:/app/data \
  -v /mnt/user/appdata/jcubhub-books/public:/app/public:ro \
  -e PORT=3003 \
  --restart unless-stopped \
  ghcr.io/YOUR_USERNAME/YOUR_REPO:latest
```

## What the Workflow Does

1. **Tests:** Runs npm tests and syntax checks on your Node.js app
2. **Builds:** Creates a multi-architecture Docker image (amd64 and arm64)
3. **Publishes:** Pushes to GitHub Container Registry (ghcr.io)
4. **Tags:** Automatically tags with:
   - `latest` for main branch
   - Branch names for other branches
   - Semantic versions for tags (e.g., `v1.0.0`)

## Triggering the Workflow

The workflow runs automatically on:
- Push to `main` or `master` branch
- Pull requests to `main` or `master`
- Creating version tags (e.g., `git tag v1.0.0 && git push --tags`)
- Manual trigger via GitHub Actions UI

## Authentication

No setup needed! The workflow uses the built-in `GITHUB_TOKEN` which is automatically provided by GitHub Actions.
