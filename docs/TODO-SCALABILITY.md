# Scalable Document Collaboration System

> **TLDR**: Future design — multi-server scaling with consistent user routing, Redis service registry, and per-user
> SQLite isolation. Nginx load balancer → API Gateway → API servers with WebSocket + Yjs. Not yet implemented.

A cost-effective, scalable architecture for document collaboration with end-to-end encryption, user-specific storage,
and real-time collaboration.

**Key Architecture Principles:**

- **SQLite databases**: Store encrypted file/folder metadata per user (NOT document content).
- **YJS documents**: Handle real-time collaborative editing in-memory (NOT persistent storage).
- **Consistent user routing**: Ensures reliability and session persistence.
- **End-to-end encryption**: Zero-knowledge server architecture.

## Architecture Overview

Consistent routing ensures requests from the same user always reach the same API server, which also handles WebSocket
connections for collaborative document editing.

```
                           ┌───────────────────┐
                           │     NGINX LOAD    │
                           │     BALANCER      │
                           └─────────┬─────────┘
                                     │
                                     ▼
                ┌────────────────────────────────────────┐
                │             API GATEWAY LAYER          │
                └────────────────────┬───────────────────┘
                                     │
                                     ▼
                            ┌─────────────────┐
                            │  REDIS SERVICE  │
                            │    REGISTRY     │
                            └─────────┬───────┘
                                      │
              ┌─────────────────────┬─┴──────────────────┐
              │                     │                    │
              ▼                     ▼                    ▼
┌───────────────────────┐ ┌───────────────────┐ ┌───────────────────────┐
│ API SERVER 1          │ │ API SERVER 2      │ │ API SERVER 3          │
│ (handles users A,B,C) │ │ (handles users D,E)│ │ (handles users F,G,H) │
├───────────────────────┤ ├───────────────────┤ ├───────────────────────┤
│ WebSocket handler     │ │ WebSocket handler │ │ WebSocket handler     │
│ YJS Documents         │ │ YJS Documents     │ │ YJS Documents         │
│ (in-memory)           │ │ (in-memory)       │ │ (in-memory)           │
└──────────┬────────────┘ └─────────┬─────────┘ └──────────┬────────────┘
           │                        │                      │
           ▼                        ▼                      ▼
┌───────────────────────┐ ┌───────────────────┐ ┌───────────────────────┐
│ User SQLite DBs       │ │ User SQLite DBs   │ │ User SQLite DBs       │
│ (metadata only)       │ │ (metadata only)   │ │ (metadata only)       │
│ + Encrypted Files     │ │ + Encrypted Files │ │ + Encrypted Files     │
└───────────────────────┘ └───────────────────┘ └───────────────────────┘
```

**Data Flow:**

- **Metadata operations** (create folder, rename file, permissions) → SQLite databases.
- **Document content operations** (read, write collaborative editing) → YJS documents in-memory.
- **Document persistence** → Encrypted files in storage layer.
- **Real-time collaboration** → WebSocket connections + YJS operational transforms.

## System Components

### 1. NGINX Load Balancer

Front-door entry point routing all incoming traffic to API Gateway instances.

- SSL termination, consistent hashing for routing, WebSocket support, throttling.

### 2. API Gateway Layer

Authenticates requests and routes them to the correct API server based on user identity.

- Session management, consistent routing, service discovery.

### 3. Redis Service Registry

Coordinates which API server handles which users.

- Maps users to API servers, provides service discovery, stores session data.

### 4. API Servers (with WebSockets)

Dedicated servers handling multiple users but maintaining user affinity.

- Manages operations for assigned users, handles WebSockets, handles encryption/decryption, orchestrates sharing.

### 5. User SQLite Databases

Per-user isolated storage for document metadata and keys.

- Stores encrypted metadata, manages keys, tracks shared access.
- *Note: SQLite is NOT used for document content.*

### 6. File Storage System

Secure storage for encrypted document content.

- Stores encrypted files (S3, local), handles upload/download, manages versioning.

### 7. YJS Document Collaboration

Real-time collaborative editing engine running in-memory on API servers.

- Manages YJS documents for active sessions, handles operational transforms, broadcasts changes.
- Ephemeral (in-memory only). Persistent storage handled separately.

## Core Design Principles

1. **Consistent User-to-Server Routing**: Load balancer uses consistent hashing based on user ID.
2. **Integrated WebSockets**: Each API server manages WebSockets for documents of its assigned users. Editors connect to
   the document owner's server.
3. **End-to-End Encryption**: Document content encrypted with document-specific keys. Encrypted metadata.
4. **Service Discovery via Redis**: Automatic failover when servers go offline.
5. **Isolated User Storage**: Per-user SQLite databases and file storage.

## Scalability Approach

1. **Horizontal Scaling**: Add API servers. Consistent hashing maintains user affinity.
2. **Resource Allocation**: API servers handle a limited number of users. Document connection limits prevent exhaustion.
3. **Database Isolation**: Per-user databases prevent cross-user performance impact.
4. **Connection Management**: Connection pooling for DB access, WebSocket limits.

## Security Model

1. **Authentication**: JWT, Redis-backed sessions, rate limiting.
2. **Encryption**: RSA key pairs per user, AES-256-GCM for content, secure key sharing.
3. **Access Control**: Document-level permissions, encryption-enforced revocation.
4. **Data Isolation**: User data segregation, zero-knowledge architecture.

## Deployment Strategy

### Docker Composition

```
docker-compose.yml
├── nginx/
├── api-gateway/
├── redis/
├── api-server/
└── monitoring/
```

### Production Deployment Options

1. **Docker Swarm**: Simple orchestration for medium scale.
2. **Kubernetes**: Advanced orchestration for large scale (auto-scaling).
3. **Cloud**: AWS ECS/EKS, GCP GKE, Azure AKS.

## Performance Considerations

### Collaboration Limits

- Max concurrent editors per YJS document (e.g., 50).
- Document size limits for in-memory YJS.

### Metadata Operations

- SQLite query optimization.
- Connection pooling for per-user databases.

### Resource Management

- Memory allocation for YJS documents.
- Storage I/O optimization.

## Special Cases

### Large Organizations (1000+ users)

- **Solution**: Group organization users on the same/neighboring API servers. Higher memory allocation. Configurable
  limits.

### Power Users (100+ active documents)

- **Solution**: Allocate to API servers with more resources. Enhanced caching (document preloading). Custom database
  optimization.

## Monitoring and Maintenance

### Key Metrics

- Active users per server, WebSocket connections, document operation latency, memory usage.

### Maintenance

- **Rolling Updates**: Zero-downtime deployment.
- **Backups**: Regular SQLite backups, encrypted off-site storage.
- **Scaling**: Automatic scaling based on metrics.
