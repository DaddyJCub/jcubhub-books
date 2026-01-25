# GitHub Actions Workflow

This directory contains GitHub Actions workflows for automating CI/CD processes.

## docker-publish.yml

Automatically tests, builds, and publishes Docker images to GitHub Container Registry (ghcr.io).

### Triggers

- **Push to main branch**: Builds and publishes with `latest` tag
- **Version tags (v*)**: Builds and publishes with semantic version tags
- **Pull requests**: Builds and tests only (no publishing)
- **Manual trigger**: Can be triggered manually from GitHub Actions UI

### Workflow Steps

1. **Test Job**
   - Checks out code
   - Sets up Node.js 18
   - Installs dependencies
   - Runs basic health check test

2. **Build and Push Job** (only runs after test passes)
   - Checks out code
   - Sets up Docker Buildx for multi-platform builds
   - Logs into GitHub Container Registry
   - Generates Docker metadata (tags and labels)
   - Builds Docker image for both amd64 and arm64 architectures
   - Pushes to ghcr.io (only for main branch pushes and tags)

### Image Tags

Images are tagged as follows:

- `latest` - Latest build from main branch
- `v1.2.3` - Full semantic version
- `v1.2` - Major.minor version
- `v1` - Major version only
- `main-<sha>` - Commit-specific build from main branch

### Using the Images

Pull the latest image:
```bash
docker pull ghcr.io/daddyjcub/jcubhub-books:latest
```

Pull a specific version:
```bash
docker pull ghcr.io/daddyjcub/jcubhub-books:v1.0.0
```

### Permissions

The workflow requires:
- `contents: read` - To check out the repository
- `packages: write` - To publish to GitHub Container Registry

These permissions are automatically granted via the `GITHUB_TOKEN` secret.

### Multi-Architecture Support

The workflow builds for both:
- `linux/amd64` - Standard x86_64 systems
- `linux/arm64` - ARM-based systems (Raspberry Pi, Apple Silicon, etc.)

This ensures compatibility with a wide range of deployment targets including Unraid.
