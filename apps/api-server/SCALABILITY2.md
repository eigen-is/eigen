# Scalable Document Collaboration with Nomad + Consul

A self-hosted, open-source architecture for document collaboration with end-to-end encryption, user-specific storage, and real-time collaboration capabilities.

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

Our system employs a flexible and scalable architecture based on HashiCorp's Nomad and Consul. This approach provides consistent routing for users while maintaining simplicity and European hosting compliance:

```
                           ┌───────────────────┐
                           │     TRAEFIK       │
                           │  LOAD BALANCER    │
                           └─────────┬─────────┘
                                     │
                                     ▼
                            ┌─────────────────┐
                            │  CONSUL SERVICE │
                            │    REGISTRY     │
                            └─────────┬───────┘
                                      │
              ┌─────────────────────┬─┴──────────────────┐
              │                     │                    │
              ▼                     ▼                    ▼
┌───────────────────────┐ ┌───────────────────┐ ┌───────────────────────┐
│ NOMAD NODE 1          │ │ NOMAD NODE 2      │ │ NOMAD NODE 3          │
│ (handles users A,B,C) │ │ (handles users D,E)│ │ (handles users F,G,H) │
├───────────────────────┤ ├───────────────────┤ ├───────────────────────┤
│                       │ │                   │ │                       │
│ API + WebSocket       │ │ API + WebSocket   │ │ API + WebSocket       │
│ services for users    │ │ services for      │ │ services for users    │
│ A, B, and C           │ │ users D and E     │ │ users F, G, and H     │
└──────────┬────────────┘ └─────────┬─────────┘ └──────────┬────────────┘
           │                        │                      │
           ▼                        ▼                      ▼
┌───────────────────────┐ ┌───────────────────┐ ┌───────────────────────┐
│ MinIO Object Storage  │ │ MinIO Object      │ │ MinIO Object Storage  │
│ + User SQLite DBs     │ │ Storage + User    │ │ + User SQLite DBs     │
│ (users A,B,C)         │ │ SQLite DBs (D,E)  │ │ (users F,G,H)         │
└───────────────────────┘ └───────────────────┘ └───────────────────────┘
```

This architecture ensures user requests and WebSocket connections are handled consistently while providing the flexibility of Nomad for application deployment and scaling.

## System Components

### 1. Traefik Load Balancer

**Purpose**: Front-door entry point that routes all incoming traffic to the appropriate API services.

**Configuration**:
- SSL termination with Let's Encrypt integration
- Consistent hashing for user-based routing
- WebSocket support
- Request throttling for DoS protection

**Docker Image**: `traefik:latest` with custom configuration

**Scaling Strategy**: Can handle hundreds of thousands of connections; multiple instances can be deployed if needed

### 2. Consul Service Registry

**Purpose**: Service discovery and configuration storage that maintains user-to-server mappings.

**Key Functions**:
- Maintains mapping of users to API servers
- Health checking of services
- Key-value store for configuration
- Service discovery for all components

**Docker Image**: `hashicorp/consul:latest`

**Scaling Strategy**: 3-5 node cluster for high availability

### 3. Nomad Orchestrator

**Purpose**: Schedules and runs services across the cluster, ensuring proper resource allocation.

**Key Functions**:
- Schedules API and WebSocket services
- Manages service restarts and failures
- Handles resource allocation
- Scales services up/down based on demand

**Docker Image**: `hashicorp/nomad:latest`

**Scaling Strategy**: 3-5 node cluster for high availability; can add more worker nodes as needed

### 4. API Services (with Integrated WebSocket)

**Purpose**: Bun + Elysia services that handle API requests and WebSocket connections for specific users.

**Key Functions**:
- Handles HTTP API requests for assigned users
- Manages WebSocket connections for collaborative editing
- Processes document encryption/decryption
- Manages user-specific SQLite databases
- Handles document sharing operations

**Docker Image**: Custom image based on `oven/bun:latest`

**Scaling Strategy**: Dynamically scaled based on user load, while maintaining consistent user-to-server mapping

### 5. User SQLite Databases

**Purpose**: Per-user isolated storage for document metadata and encryption keys.

**Key Functions**:
- Stores encrypted file metadata
- Manages encryption keys for documents
- Tracks shared document access
- Maintains folder structures and permissions

**Storage Location**: Each user's SQLite database is stored in a dedicated volume

**Scaling Strategy**: One database per user; sharding for organizations and power users

### 6. MinIO Object Storage

**Purpose**: S3-compatible storage for encrypted document content.

**Key Functions**:
- Stores encrypted file content
- Manages data versioning
- Provides high durability storage
- Supports multi-tenant isolation

**Docker Image**: `minio/minio:latest`

**Scaling Strategy**: Distributed deployment across multiple nodes for scalability and redundancy

## Core Design Principles

### 1. Service Discovery and Routing

- Consul service catalog automatically registers and deregisters services
- Traefik dynamically updates routes based on Consul catalog
- User-to-server allocation maintained in Consul KV store
- Sticky sessions ensure users stay on the same server

### 2. User-Based API Server Selection

- When a user first registers, Consul assigns them to an API server based on:
  1. Current server load (CPU, memory utilization)
  2. Number of users already assigned to each server
  3. Geographical proximity (if multiple regions are deployed)
- This assignment is stored in Consul's key-value store
- All subsequent requests from this user are routed to the same API server
- If an API server becomes unavailable, Consul's health checks detect this and reassign users

### 3. Integrated WebSocket Handling

- WebSocket connections are handled by the same API server that processes HTTP requests
- Each API server has its own integrated WebSocket server
- Connection information for collaborative editing is stored in-memory on the API server
- Document owners' API servers act as collaboration hubs
- Collaborators connect directly to the document owner's assigned API server

### 4. End-to-End Encryption

- Document content encrypted with document-specific keys (AES-256-GCM)
- User-specific RSA key pairs for key exchange
- Encrypted metadata for privacy
- Key sharing mechanism for document collaboration

### 5. Isolated User Storage

- Per-user SQLite databases
- User-specific MinIO buckets/paths
- Data isolation at both application and storage levels

## Scalability Approach

Our system scales through several mechanisms:

### 1. Dynamic Allocation with Nomad

- Nomad automatically schedules and scales API services
- Resources allocated based on user load patterns
- API services can be scaled horizontally as needed
- Bin-packing algorithm ensures efficient resource utilization

### 2. Consistent User-to-Server Mapping

- Consul maintains persistent mapping of users to servers
- Even during scaling events, users remain on their assigned servers
- New servers added to the cluster receive new user assignments
- If a server is removed, users are redistributed automatically

### 3. Database Isolation

- Per-user SQLite databases prevent query contention
- Data isolation ensures one user's load doesn't affect others
- Sharding for organizations and power users

### 4. Connection Management

- WebSocket connection limits per document
- Resources allocated per user based on activity patterns
- Connection pooling for external services

## Security Model

### 1. Authentication Layer

- JWT-based authentication with short expiration
- Secure cookie handling
- Rate limiting and brute force protection
- Support for MFA and SSO integration

### 2. Encryption Architecture

- RSA public/private key pairs per user (2048-bit)
- AES-256-GCM for document content encryption
- Encrypted metadata (filenames, paths)
- Secure key sharing mechanism for collaboration (as detailed in ENCRYPTION.md)

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

### Infrastructure Setup

```
nomad/                              # Nomad job definitions
├── traefik.nomad                   # Load balancer service
├── api-service.nomad               # API and WebSocket service
├── minio.nomad                     # Object storage service
└── monitoring.nomad                # Monitoring stack (Prometheus, Grafana)
```

### Initial Deployment (Development/Testing)

- 3 Nomad servers (for consensus)
- 3 Nomad clients (for running workloads)
- 3 Consul servers (for service discovery)
- 1 Traefik instance
- 3 MinIO instances

### Production Deployment Options

1. **On-Premises**
   - Deploy on your own hardware
   - Full control over infrastructure
   - Ideal for privacy-conscious organizations

2. **European Cloud Providers**
   - Hetzner Cloud
   - OVHcloud
   - Scaleway
   - Any provider offering dedicated VMs

3. **Hybrid Approach**
   - Core services on-premises
   - Object storage in compliant cloud providers
   - Scaling capacity in cloud as needed

## Implementation Roadmap

### Phase 1: Core Infrastructure

1. Base Nomad and Consul cluster setup
2. Traefik configuration with Consul integration
3. API service definition and deployment
4. User-to-server mapping implementation
5. Authentication system

### Phase 2: Storage and Encryption

1. MinIO cluster setup
2. SQLite per-user database implementation
3. End-to-end encryption implementation
4. Key management system

### Phase 3: Collaborative Editing

1. WebSocket implementation in API services
2. Document session management
3. Real-time synchronization
4. Operational transformation or CRDT implementation

### Phase 4: Scaling and Optimization

1. Load balancing refinement
2. Resource monitoring with Prometheus
3. Auto-scaling implementation with Nomad
4. Performance optimization

### Phase 5: Additional Features

1. Access control and sharing
2. Document version history
3. Notifications and collaboration features
4. Administrative tools

## Performance Considerations

### Document Limits

- Maximum concurrent editors per document (e.g., 50)
- Document size limits for collaborative editing
- Rate limiting for rapid changes

### Resource Management

- Memory allocation per API service
- WebSocket connection limits
- API server user capacity planning

### Optimization Techniques

- Efficient WebSocket message format
- Batched document updates
- Incremental synchronization
- Shared worker processes for background tasks

### Caching Strategy

- In-memory document caching
- Session caching
- User preference caching

## Special Cases: Organizations and Power Users

### Large Organizations (1000+ users)

**Challenge**: Organizations share many documents among thousands of users.

**Solution**:
1. **API Service Grouping via Nomad Constraints**
   - Organization users can be assigned to specific Nomad nodes
   - Custom Nomad constraints ensure related users are placed together
   - Improved performance for intra-organization collaboration

2. **Resource Allocation**
   - Higher resource allocation for API services handling organization users
   - Customized Nomad job specifications with higher memory and CPU limits

3. **Document Limits**
   - Configurable limits for organization documents
   - Premium tier options for higher limits

### Power Users (100+ active documents)

**Challenge**: Power users have many documents and high activity.

**Solution**:
1. **Dedicated Resources via Nomad Priorities**
   - Power users can be assigned to Nomad nodes with more resources
   - Custom priority in Nomad job specifications

2. **Enhanced Caching**
   - Increased cache allocation for power users
   - Document preloading for frequently accessed content

3. **Performance Tuning**
   - Custom SQLite optimization for power users
   - Prioritized request handling

## Monitoring and Maintenance

### Key Metrics

- Active users per API service
- WebSocket connections per server
- Document operation latency
- Memory usage per server
- Database operation timing
- Document user counts

### Alerting System

- Prometheus for metrics collection
- Alertmanager for notification routing
- Server health degradation alerts
- Resource exhaustion warnings

### Maintenance Procedures

1. **Rolling Updates**
   - Zero-downtime deployment using Nomad's update strategies
   - Server rotation without disruption
   - Gradual rollout with monitoring

2. **Backup Strategy**
   - Regular SQLite database backups
   - MinIO snapshot backups
   - Consul and Nomad state backups
   - Point-in-time recovery options

3. **Scaling Operations**
   - Add new Nomad clients to increase capacity
   - Adjust resource allocation for existing services
   - Scheduled capacity adjustments for known high-usage periods

4. **Disaster Recovery**
   - Multi-region redundancy option
   - Service failover procedures
   - Data consistency verification

---

This architecture delivers a secure, self-hosted, and scalable document collaboration system that:

1. **Maximizes simplicity** by integrating API and WebSocket handling in a single service
2. **Maintains consistency** with user-to-server affinity through Consul
3. **Scales horizontally** by adding more Nomad nodes as needed
4. **Secures data** through end-to-end encryption
5. **Supports European hosting** with fully open-source components
6. **Provides resilience** through Nomad's scheduling and Consul's health checking

The consistent user routing through Consul ensures reliability while the flexible scheduling provided by Nomad allows for efficient resource utilization and simplified operations.
