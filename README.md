# JcubHub Books

A unified book request and library portal with SQLite database, JWT authentication, and integrations with Readarr and Calibre Web Automated (CWA).

## Features

- 📚 Book request submission system
- 🔒 Admin authentication with JWT
- 📧 Email notifications (via Zoho Mail)
- 🤖 Cloudflare Turnstile CAPTCHA protection
- 📖 Readarr integration for automatic book downloads
- 📚 CWA (Calibre Web Automated) integration
- 🔔 Webhook support for automated status updates
- 🗄️ SQLite database for data persistence
- 🐳 Docker support

## Docker Deployment

### Using Docker Compose (Development)

```bash
# Copy environment file and configure
cp .env.example .env
# Edit .env with your settings

# Build and run
docker-compose up -d
```

The application will be available at `http://localhost:3003`

### Using Pre-built Docker Image

Docker images are automatically built and published to GitHub Container Registry (ghcr.io) on every commit to the main branch.

#### Pull from GitHub Container Registry

```bash
docker pull ghcr.io/daddyjcub/jcubhub-books:latest
```

#### Run the container

```bash
docker run -d \
  --name jcubhub-books \
  -p 3003:3003 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/public:/app/public:ro \
  -e PORT=3003 \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=your-secure-password \
  --restart unless-stopped \
  ghcr.io/daddyjcub/jcubhub-books:latest
```

### Unraid Deployment

1. **Open Unraid Docker Tab**
   - Go to Docker tab in Unraid
   - Click "Add Container"

2. **Configure Container**
   - **Name**: `jcubhub-books`
   - **Repository**: `ghcr.io/daddyjcub/jcubhub-books:latest`
   - **Network Type**: `Bridge`
   - **Port Mapping**:
     - Container Port: `3003`
     - Host Port: `3003` (or your preferred port)
   
3. **Volume Mappings** (recommended):
   - **Container Path**: `/app/data`
     - **Host Path**: `/mnt/user/appdata/jcubhub-books/data`
     - **Access Mode**: Read/Write
   
4. **Environment Variables**:
   Add the following environment variables:
   - `PORT=3003`
   - `ADMIN_USERNAME=your-admin-username`
   - `ADMIN_PASSWORD=your-secure-password`
   - `JWT_SECRET=your-random-secret`
   - (Optional) Other env vars from `.env.example`

5. **Click Apply** to create and start the container

6. **Access the Application**
   - Visit `http://your-unraid-ip:3003`
   - Admin panel: `http://your-unraid-ip:3003/admin`

### Environment Variables

See `.env.example` for a complete list of environment variables. Key variables:

- `PORT` - Server port (default: 3003)
- `ADMIN_USERNAME` - Default admin username
- `ADMIN_PASSWORD` - Default admin password
- `JWT_SECRET` - Secret for JWT token signing
- `ADMIN_EMAIL` - Email for admin notifications
- `ZOHO_EMAIL` - Zoho email for sending notifications
- `ZOHO_PASSWORD` - Zoho app password
- `TURNSTILE_SECRET_KEY` - Cloudflare Turnstile secret
- `READARR_URL` - Readarr server URL
- `READARR_API_KEY` - Readarr API key
- `CWA_URL` - Calibre Web Automated URL
- `CWA_USERNAME` - CWA username
- `CWA_PASSWORD` - CWA password
- `WEBHOOK_SECRET` - Webhook verification secret

## Development

### Prerequisites

- Node.js 18 or higher
- npm

### Local Setup

```bash
# Install backend dependencies
cd backend
npm install

# Copy environment file
cp ../.env.example ../.env
# Edit .env with your settings

# Run the server
npm start
```

The server will start on `http://localhost:3003`

### API Endpoints

#### Public Endpoints
- `GET /api/health` - Health check
- `POST /api/book-request` - Submit a book request

#### Auth Endpoints
- `POST /api/auth/login` - Admin login
- `GET /api/auth/verify` - Verify JWT token

#### Admin Endpoints (require authentication)
- `GET /api/admin/requests` - Get all requests
- `GET /api/admin/requests/:id` - Get single request with history
- `PATCH /api/admin/requests/:id` - Update request status
- `DELETE /api/admin/requests/:id` - Delete request
- `GET /api/admin/stats` - Get dashboard statistics
- `GET /api/admin/readarr/search` - Search Readarr
- `POST /api/admin/readarr/add` - Add book to Readarr
- `POST /api/admin/sync-cwa` - Sync with CWA library

#### Webhook Endpoints
- `POST /api/webhook/book-complete` - Webhook for book completion (Readarr/Chaptarr)

## CI/CD

This repository uses GitHub Actions to automatically:
- Test the application on pull requests and pushes
- Build Docker images for multiple architectures (amd64, arm64)
- Publish images to GitHub Container Registry (ghcr.io)

### Available Docker Image Tags

- `latest` - Latest build from main branch
- `v*` - Version tags (e.g., v1.0.0, v1.0, v1)
- `main-<sha>` - Commit-specific builds

To use a specific version:
```bash
docker pull ghcr.io/daddyjcub/jcubhub-books:v1.0.0
```

## License

MIT
