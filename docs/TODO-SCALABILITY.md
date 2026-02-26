# Scalable Document Collaboration System

A simple, cost-effective, and scalable architecture for document collaboration with end-to-end encryption, user-specific
storage, and real-time collaboration capabilities.

**Key Architecture Principles:**

- **SQLite databases**: Store encrypted file/folder metadata per user (NOT document content)
- **YJS documents**: Handle real-time collaborative editing in-memory (NOT persistent storage)
- **Consistent user routing**: Ensures reliability and session persistence
- **End-to-end encryption**: Zero-knowledge server architecture

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [System Components](#system-components)
- [Core Design Principles](#core-design-principles)
- [Scalability Approach](#scalability-approach)
- [Security Model](#security-model)
- [Deployment Strategy](#deployment-strategy)
- [Implementation Roadmap](#implementation-roadmap)
- [Performance Considerations](#performance-considerations)
- [Special Cases: Organizations and Power Users](#special-cases-organizations-and-power-users)
- [Monitoring and Maintenance](#monitoring-and-maintenance)

## Architecture Overview

Our system employs a straightforward architecture designed for simplicity and scalability, with a consistent routing
strategy that ensures requests from the same user always reach the same API server, which also handles WebSocket
connections for collaborative document editing:

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
│                       │ │                   │ │                       │
│ WebSocket handler for │ │ WebSocket handler │ │ WebSocket handler for │
│ all documents of      │ │ for all docs of   │ │ all documents of      │
│ users A, B, and C     │ │ users D and E     │ │ users F, G, and H     │
│                       │ │                   │ │                       │
│ YJS Documents         │ │ YJS Documents     │ │ YJS Documents         │
│ (in-memory)           │ │ (in-memory)       │ │ (in-memory)           │
└──────────┬────────────┘ └─────────┬─────────┘ └──────────┬────────────┘
           │                        │                      │
           ▼                        ▼                      ▼
┌───────────────────────┐ ┌───────────────────┐ ┌───────────────────────┐
│ User SQLite DBs       │ │ User SQLite DBs   │ │ User SQLite DBs       │
│ (metadata only)       │ │ (metadata only)   │ │ (metadata only)       │
│ + Encrypted Files     │ │ + Encrypted Files │ │ + Encrypted Files     │
│ (users A,B,C)         │ │ (users D,E)       │ │ (users F,G,H)         │
└───────────────────────┘ └───────────────────┘ └───────────────────────┘
```

**Data Flow Explanation:**

- **Metadata operations** (create folder, rename file, permissions) → SQLite databases
- **Document content operations** (read, write collaborative editing) → YJS documents in-memory
- **Document persistence** → Encrypted files in storage layer
- **Real-time collaboration** → WebSocket connections + YJS operational transforms

This architecture maximizes simplicity while maintaining scalability, ensuring user requests and WebSocket connections
are handled consistently.

## System Components

### 1. NGINX Load Balancer

**Purpose**: Front-door entry point that routes all incoming traffic to the appropriate API Gateway instances.

**Configuration**:

- SSL termination
- Consistent hashing for user-based routing
- WebSocket support
- Request throttling for DoS protection

**Docker Image**: `nginx:alpine` with custom configuration

**Scaling Strategy**: Can handle hundreds of thousands of connections; multiple instances can be deployed if needed

### 2. API Gateway Layer

**Purpose**: Authenticates requests and routes them to the correct API server based on user identity.

**Key Functions**:

- User authentication and session management
- Consistent user-to-server routing
- Service discovery via Redis
- Request distribution

**Docker Image**: Custom image based on `oven/bun:latest`

**Scaling Strategy**: Horizontally scalable; multiple identical instances run behind the load balancer

### 3. Redis Service Registry

**Purpose**: Coordinates which API server handles which users.

**Key Functions**:

- Maintains mapping of users to API servers
- Provides service discovery
- Stores short-lived session data
- Manages server health information

**Docker Image**: `redis:alpine`

**Scaling Strategy**: Initially single instance; can be clustered for high availability

### 4. API Servers (with Integrated WebSocket)

**Purpose**: Dedicated servers that handle multiple users but maintain user affinity, including WebSocket connections.

**Key Functions**:

- Manages all operations for assigned users
- Handles WebSocket connections for collaborative editing
- Handles document encryption/decryption
- Stores and retrieves user-specific data
- Orchestrates document sharing
- Manages real-time collaboration

**Docker Image**: Custom image based on `oven/bun:latest`

**Scaling Strategy**: Dynamically scaled based on user load, while maintaining consistent user-to-server mapping

### 5. User SQLite Databases

**Purpose**: Per-user isolated storage for document metadata and keys.

**Key Functions**:

- Stores encrypted file metadata (filenames, paths, permissions)
- Manages encryption keys for documents
- Tracks shared document access
- Maintains folder structures and permissions

**Storage Location**: Each user's SQLite database is stored in a dedicated location

**Scaling Strategy**: One database per user; sharding for organizations and power users

**Important Note**: SQLite is NOT used for document content or collaborative editing - only for metadata storage.

### 6. File Storage System

**Purpose**: Secure storage for encrypted document content.

**Key Functions**:

- Stores encrypted document files (S3, local storage, etc.)
- Handles file upload/download operations
- Manages file versioning and backup

### 7. YJS Document Collaboration

**Purpose**: Real-time collaborative editing engine running in-memory on API servers.

**Key Functions**:

- Manages YJS documents for active collaborative sessions
- Handles operational transforms and conflict resolution
- Broadcasts changes via WebSockets to connected clients
- Maintains document state only while users are actively editing

**Data Flow**:

1. User opens document → API server loads YJS document into memory
2. Multiple users edit → YJS handles real-time synchronization
3. Periodic saves → Document content encrypted and stored in file system
4. Session ends → YJS document removed from memory

**Important Notes**:

- YJS documents are ephemeral (in-memory only during active sessions)
- Persistent storage handled separately via encrypted file system
- Each API server manages YJS documents for its assigned users

## Core Design Principles

### 1. Consistent User-to-Server Routing

- Requests from the same user always go to the same API server
- Load balancer uses consistent hashing based on user ID
- Ensures consistent performance and session handling
- Simplifies caching and state management

### 2. Integrated WebSockets

- WebSocket connections for collaborative editing handled by the same API server
- Each API server manages WebSockets for documents of its assigned users
- Document editors connect to the API server of the document owner
- Hard limit on concurrent editors per document (e.g., 50 users)

### 3. End-to-End Encryption

- Document content encrypted with document-specific keys
- User-specific key management
- Encrypted metadata for privacy
- Key sharing for document collaboration

### 4. Service Discovery via Redis

- API servers register which users they handle
- Automatic failover when servers go offline
- Simple and reliable mechanism for locating services

### 5. Isolated User Storage

- Per-user SQLite databases
- User-specific file storage
- Encrypted data at rest

## Scalability Approach

Our system scales through several mechanisms:

### 1. Horizontal Scaling of API Servers

- Add more API servers as user count grows
- Consistent hashing ensures users stay on the same server when possible
- Even user distribution across servers for balanced load

### 2. Resource Allocation

- Each API server handles a limited number of users
- Memory and CPU resources allocated based on expected user activity
- Document connection limits prevent resource exhaustion

### 3. Database Isolation

- Per-user databases prevent cross-user performance impact
- Data sharding for high-volume users

### 4. Connection Management

- Connection pooling for database access
- WebSocket connection limits
- Efficient management of concurrent connections

## Security Model

### 1. Authentication Layer

- JWT-based authentication
- Redis-backed session management
- Rate limiting and brute force protection
- Support for MFA and SSO integration

### 2. Encryption Architecture

- RSA public/private key pairs per user
- AES-256-GCM for document content encryption
- Encrypted metadata (filenames, paths)
- Secure key sharing mechanism for collaboration

### 3. Access Control

- Document-level permissions
- Versioned access controls
- Encryption-enforced access revocation
- Audit logging for compliance

### 4. Data Isolation

- User data segregation
- Encrypted SQLite databases
- Zero-knowledge architecture (server never sees unencrypted content)

## Deployment Strategy

### Docker Composition

```
docker-compose.yml                 # Main services
├── nginx/                         # Load balancer configuration
├── api-gateway/                   # API Gateway service
├── redis/                         # Service registry
├── api-server/                    # API server with integrated WebSockets
└── monitoring/                    # Monitoring stack (Prometheus, Grafana)
```

### Initial Deployment (Development/Testing)

- 1 NGINX instance
- 2 API Gateway instances
- 1 Redis instance
- 3-5 API Server instances

### Production Deployment Options

1. **Docker Swarm**
    - Simple orchestration for medium-scale deployments
    - Easy setup and management

2. **Kubernetes**
    - Advanced orchestration for large-scale deployments
    - Auto-scaling based on metrics

3. **Cloud Provider Integration**
    - AWS ECS/EKS
    - GCP GKE
    - Azure AKS
    - Managed container services

## Implementation Roadmap

### Phase 1: Core Infrastructure

1. Basic Docker setup
2. NGINX configuration with consistent routing
3. API Gateway implementation
4. Redis service registry
5. API server with integrated WebSockets
6. Authentication system

### Phase 2: Storage and Encryption

1. SQLite per-user database implementation
2. End-to-end encryption implementation
3. S3 integration
4. Key management system

### Phase 3: Collaborative Editing

1. WebSocket implementation in API servers
2. Document session management
3. Real-time synchronization
4. Operational transformation or CRDT implementation

### Phase 4: Scaling and Optimization

1. Load balancing refinement
2. Resource monitoring
3. Auto-scaling implementation
4. Performance optimization

### Phase 5: Additional Features

1. Access control and sharing
2. Document version history
3. Notifications and collaboration features
4. Administrative tools

## Performance Considerations

### Document Collaboration Limits

- Maximum concurrent editors per YJS document (e.g., 50)
- Document size limits for in-memory YJS documents
- Rate limiting for rapid collaborative changes
- Memory allocation per active document session

### Metadata Operations Performance

- SQLite query optimization for file/folder operations
- Connection pooling for per-user databases
- Indexing strategy for frequently accessed metadata
- Batch operations for bulk file operations

### Resource Management

- Memory allocation per API server for YJS documents
- WebSocket connection limits per server
- SQLite database connection pooling per user
- Storage I/O optimization for document persistence

### Optimization Techniques

- Efficient WebSocket message format
- Batched document updates
- Incremental synchronization

### Caching Strategy

- In-memory document caching
- Session caching
- User preference caching

## Special Cases: Organizations and Power Users

### Large Organizations (1000+ users)

**Challenge**: Organizations share many documents among thousands of users.

**Solution**:

1. **API Server Grouping**
    - Organization users can be grouped on the same or neighboring API servers
    - Improved performance for intra-organization collaboration

2. **Resource Allocation**
    - Higher memory allocation for API servers handling organization users
    - Optimized database connections

3. **Document Limits**
    - Configurable limits for organization documents
    - Premium tier options for higher limits

### Power Users (100+ active documents)

**Challenge**: Power users have many documents and high activity.

**Solution**:

1. **Dedicated Resources**
    - Power users can be allocated to API servers with more resources
    - Lower user-to-server ratio for power users

2. **Enhanced Caching**
    - Increased cache allocation for power users
    - Document preloading for frequently accessed content

3. **Performance Tuning**
    - Custom database optimization
    - Prioritized request handling

## Monitoring and Maintenance

### Key Metrics

- Active users per API server
- WebSocket connections per server
- Document operation latency
- Memory usage per server
- Database operation timing
- Document user counts

### Alerting System

- Server health degradation alerts
- Resource exhaustion warnings
- Error rate monitoring
- Performance anomaly detection

### Maintenance Procedures

1. **Rolling Updates**
    - Zero-downtime deployment strategy
    - Server rotation without disruption
    - Gradual rollout with monitoring

2. **Backup Strategy**
    - Regular SQLite database backups
    - Encrypted off-site storage
    - Point-in-time recovery options

3. **Scaling Operations**
    - Automatic scaling based on metrics
    - Manual scaling for anticipated events
    - Scheduled capacity adjustments

4. **Disaster Recovery**
    - Multi-region redundancy option
    - Service failover procedures
    - Data consistency verification

---

This architecture delivers a simple yet scalable document collaboration system that:

1. **Maximizes simplicity** by integrating API and WebSocket handling
2. **Maintains consistency** with user-to-server affinity
3. **Scales horizontally** by adding more API servers as needed
4. **Secures data** through end-to-end encryption
5. **Supports growth** with a straightforward, container-based design

The consistent user routing ensures reliability while the integrated WebSocket handling simplifies the architecture,
making it easier to deploy and maintain.