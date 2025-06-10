# Secure File Sharing System with End-to-End Encryption

This repository contains a secure file sharing system similar to Google Drive, but with robust end-to-end encryption. The system allows users to securely store, share, and manage files while protecting both content and metadata from unauthorized access.

## Architecture Overview

The system implements a hybrid cryptographic approach with the following key components:

1. **User-based Key Management**: Each user has a public/private key pair for secure key exchange
2. **Directory Key Hierarchy**: Each directory has its own key that encrypts file keys and subdirectory keys
3. **Per-file Encryption**: Each file has its own symmetric encryption key
4. **Encrypted Metadata**: Sensitive metadata (filenames, paths) is encrypted separately
5. **Secure Sharing Mechanism**: Directories and files can be shared without re-encrypting content

## Cryptographic Design

### Key Hierarchy

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  User Password  │────>│  User Key Pair  │────>│ Directory Keys  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │ File Keys (AES) │
                                                └─────────────────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │ File Content &  │
                                                │ Metadata        │
                                                └─────────────────┘
```

### User Authentication & Key Generation

1. **Registration**:
   - User creates an account with a strong password
   - System generates an RSA key pair (2048-bit)
   - Private key is encrypted with a key derived from the user's password using PBKDF2
   - Public key and encrypted private key are stored in the database

2. **Authentication**:
   - User logs in with password
   - System derives key from password and decrypts the user's private key
   - Private key is held in memory only during the user's session

### File Encryption Process

1. **Upload**:
   - Generate a random AES-256 key for the file
   - Encrypt file content with AES-256-GCM using this key
   - Encrypt the file key with the directory key
   - Encrypt sensitive metadata (filename, path) with the same file key
   - Store encrypted file, encrypted metadata, and encrypted file key

2. **Download**:
   - Retrieve encrypted directory key and decrypt it with user's private key
   - Use directory key to decrypt the file key
   - Use file key to decrypt file content and metadata
   - Present decrypted file to user

### Directory Key Management

1. **Directory Structure**:
   - Each directory has its own AES-256 key
   - The directory key encrypts all file keys and subdirectory keys within it
   - This forms a hierarchical key structure that simplifies sharing

2. **Directory Creation**:
   - Generate a random AES-256 key for the directory
   - Encrypt the directory key with the user's public key
   - If it's a subdirectory, also encrypt its key with the parent directory's key
   - Store the encrypted directory key

### Sharing Mechanism

1. **Share File**:
   - Owner decrypts the file key using their private key
   - System encrypts the file key with recipient's public key
   - System encrypts metadata with the file key for the recipient
   - Store new encrypted file key and metadata records for recipient

2. **Share Directory**:
   - Owner decrypts the directory key using their private key
   - System encrypts the directory key with recipient's public key
   - Store the encrypted directory key for the recipient
   - The recipient gains access to all files and subdirectories within the shared directory

3. **Access Revocation**:
   - For file access: Delete the encrypted file key record for the revoked user
   - For directory access: Delete the encrypted directory key record for the revoked user
   - User immediately loses access to the keys, and thus the files/directories

### Metadata Protection

Metadata is split into two categories:

1. **Non-sensitive Metadata** (stored unencrypted):
   - File ID
   - File size
   - MIME type
   - Creation/modification timestamps

2. **Sensitive Metadata** (encrypted with file key):
   - File name
   - File path/location
   - Custom attributes/tags

## Database Schema

```sql
-- Users
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- User Keys
CREATE TABLE user_keys (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  encrypted_private_key BYTEA NOT NULL,
  public_key TEXT NOT NULL,
  salt BYTEA NOT NULL,
  iv BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Directories
CREATE TABLE directories (
  id VARCHAR(36) PRIMARY KEY,
  parent_id VARCHAR(36) REFERENCES directories(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Directory Keys
CREATE TABLE directory_keys (
  directory_id VARCHAR(36) REFERENCES directories(id),
  user_id INTEGER REFERENCES users(id),
  encrypted_directory_key BYTEA NOT NULL,
  iv BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  PRIMARY KEY (directory_id, user_id)
);

-- Directory Metadata
CREATE TABLE encrypted_directory_metadata (
  directory_id VARCHAR(36) REFERENCES directories(id),
  user_id INTEGER REFERENCES users(id),
  encrypted_metadata BYTEA NOT NULL,
  iv BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  PRIMARY KEY (directory_id, user_id)
);

-- Files (Non-sensitive metadata)
CREATE TABLE files (
  id VARCHAR(36) PRIMARY KEY,
  directory_id VARCHAR(36) REFERENCES directories(id),
  mime_type VARCHAR(255) NOT NULL,
  size BIGINT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Encrypted File Metadata
CREATE TABLE encrypted_file_metadata (
  file_id VARCHAR(36) REFERENCES files(id),
  user_id INTEGER REFERENCES users(id),
  encrypted_metadata BYTEA NOT NULL,
  iv BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  PRIMARY KEY (file_id, user_id)
);

-- File Keys
CREATE TABLE file_keys (
  file_id VARCHAR(36) REFERENCES files(id),
  directory_id VARCHAR(36) REFERENCES directories(id),
  user_id INTEGER REFERENCES users(id),
  encrypted_file_key BYTEA NOT NULL,
  iv BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  PRIMARY KEY (file_id, user_id)
);

-- Public Links
CREATE TABLE public_links (
  id VARCHAR(36) PRIMARY KEY,
  resource_id VARCHAR(36) NOT NULL,
  resource_type VARCHAR(10) NOT NULL, -- 'file' or 'directory'
  encrypted_resource_key BYTEA NOT NULL,
  iv BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Account Recovery (Optional)
CREATE TABLE recovery_keys (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  encrypted_private_key BYTEA NOT NULL,
  salt BYTEA NOT NULL,
  iv BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

## Core Components

### 1. User Service

Manages user creation, authentication, and key generation.

Key functions:
- `registerUser(username, password)`: Creates new user with key pair
- `authenticateUser(username, password)`: Authenticates and retrieves private key
- `changePassword(userId, oldPassword, newPassword)`: Updates password and re-encrypts private key

### 2. File Service

Handles file and directory operations with encryption.

Key functions:
- `createDirectory(name, parentId, userId, privateKey)`: Creates a new encrypted directory
- `uploadFile(fileData, metadata, userId, privateKey, directoryId)`: Encrypts and stores a new file in a directory
- `getFile(fileId, userId, privateKey)`: Retrieves and decrypts a file
- `shareDirectory(directoryId, ownerId, targetUserId, ownerPrivateKey)`: Shares a directory and all its contents
- `shareFile(fileId, ownerId, targetUserId, ownerPrivateKey)`: Shares a file with another user
- `createPublicLink(resourceId, resourceType, userId, privateKey, expiresAt)`: Creates a public link for a file or directory
- `revokeAccess(fileId, targetUserId)`: Revokes a user's access to a file
- `revokeDirectoryAccess(directoryId, targetUserId)`: Revokes a user's access to a directory
- `renameFile(fileId, newName, userId, privateKey)`: Updates file metadata
- `renameDirectory(directoryId, newName, userId, privateKey)`: Updates directory metadata

### 3. Encryption Utils

Provides cryptographic primitives for the system.

Key functions:
- `generateKeyPair()`: Creates RSA key pair for users
- `deriveKeyFromPassword(password, salt)`: Derives key from user password
- `encryptWithSymmetricKey(data, key)`: Encrypts data with AES-256-GCM
- `decryptWithSymmetricKey(encrypted, key, iv, authTag)`: Decrypts AES-encrypted data
- `encryptWithPublicKey(data, publicKey)`: Encrypts data with RSA public key
- `decryptWithPrivateKey(encryptedData, privateKey)`: Decrypts data with RSA private key
- `generateFileKey()`: Creates random AES-256 key for file encryption
- `generateDirectoryKey()`: Creates random AES-256 key for directory encryption
- `encryptDirectoryKey(directoryKey, publicKey)`: Encrypts directory key with user's public key
- `encryptDirectoryKeyWithParentKey(directoryKey, parentDirectoryKey)`: Encrypts directory key with parent directory key

### 4. Session Service

Manages user sessions and secure key handling.

Key functions:
- `createSession(userId, privateKey)`: Creates new session with private key in memory
- `getSession(sessionId)`: Retrieves session with private key
- `invalidateSession(sessionId)`: Terminates session and removes private key from memory

### 5. Account Recovery Service (Optional)

Provides password recovery options while maintaining security.

Key functions:
- `generateRecoveryKey(userId, privateKey)`: Creates recovery key for account
- `recoverAccount(userId, recoveryKey)`: Recovers account access using recovery key
- `resetPassword(userId, newPassword, privateKey)`: Sets new password after recovery

## API Endpoints

### User Management
- `POST /api/users/register`: Register new user
- `POST /api/users/login`: Authenticate user and create session
- `POST /api/users/logout`: End user session
- `POST /api/users/change-password`: Update user password

### Directory Operations
- `POST /api/directories/create`: Create new directory
- `GET /api/directories/list/:directoryId?`: List contents of directory
- `PUT /api/directories/:directoryId/rename`: Rename directory
- `DELETE /api/directories/:directoryId`: Delete directory and contents

### File Operations
- `POST /api/files/upload`: Upload and encrypt new file
- `GET /api/files/download/:fileId`: Download and decrypt file
- `PUT /api/files/:fileId/rename`: Rename file
- `DELETE /api/files/:fileId`: Delete file

### Sharing
- `POST /api/files/share/:fileId`: Share file with another user
- `POST /api/directories/share/:directoryId`: Share directory with another user
- `POST /api/files/revoke/:fileId`: Revoke access to shared file
- `POST /api/directories/revoke/:directoryId`: Revoke access to shared directory
- `GET /api/resources/shared-with-me`: List files and directories shared with current user
- `GET /api/resources/shared-by-me`: List files and directories shared by current user
- `POST /api/resources/public-link`: Create public link for a file or directory

### Recovery (Optional)
- `POST /api/recovery/generate-key`: Generate account recovery key
- `POST /api/recovery/initiate`: Start account recovery process
- `POST /api/recovery/recover-with-key`: Recover account using recovery key

## Implementation Guidelines

### 1. Encryption Standards

- **User Key Pairs**: RSA-2048
- **File Encryption**: AES-256-GCM
- **Password Derivation**: PBKDF2 with SHA-256, 100,000+ iterations
- **Random Generation**: Use cryptographically secure random number generators

### 2. Security Considerations

- **Zero Knowledge**: Server never has access to unencrypted private keys or file keys
- **Memory Management**: Clear sensitive data from memory after use
- **Key Rotation**: Support for rotating file keys when needed
- **Session Timeouts**: Automatically invalidate sessions after period of inactivity

### 3. Performance Optimization

- **Chunked Encryption**: For large files, encrypt in chunks to manage memory
- **Caching**: Cache decrypted metadata (but not keys) during user session
- **Background Processing**: Handle key rotation and sharing operations asynchronously

### 4. Error Handling

- **Cryptographic Failures**: Properly handle and log encryption/decryption failures
- **Access Denial**: Return appropriate errors for unauthorized access attempts
- **Corrupt Data**: Detect and manage corrupted encrypted data

## Sample Implementation Code

Below are key TypeScript functions demonstrating the core encryption functionalities:

### User Key Generation

```typescript
import crypto from 'crypto';

async function generateUserKeys(password: string): Promise<{
  publicKey: string;
  encryptedPrivateKey: Buffer;
  salt: Buffer;
  iv: Buffer;
  authTag: Buffer;
}> {
  // Generate RSA key pair
  const { publicKey, privateKey } = await new Promise<{publicKey: string, privateKey: string}>((resolve, reject) => {
    crypto.generateKeyPair('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    }, (err, publicKey, privateKey) => {
      if (err) reject(err);
      else resolve({ publicKey, privateKey });
    });
  });

  // Derive key from password
  const salt = crypto.randomBytes(16);
  const derivedKey = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  
  // Encrypt private key with password-derived key
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);
  
  const encryptedPrivateKey = Buffer.concat([
    cipher.update(Buffer.from(privateKey)),
    cipher.final()
  ]);
  
  const authTag = cipher.getAuthTag();
  
  return {
    publicKey,
    encryptedPrivateKey,
    salt,
    iv,
    authTag
  };
}
```

### File Encryption

```typescript
function encryptFile(
  fileData: Buffer,
  fileKey: Buffer = crypto.randomBytes(32)
): {
  encryptedData: Buffer;
  iv: Buffer;
  authTag: Buffer;
  fileKey: Buffer;
} {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', fileKey, iv);
  
  const encryptedData = Buffer.concat([
    cipher.update(fileData),
    cipher.final()
  ]);
  
  const authTag = cipher.getAuthTag();
  
  return {
    encryptedData,
    iv,
    authTag,
    fileKey
  };
}

function encryptFileKey(
  fileKey: Buffer,
  publicKey: string
): Buffer {
  return crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING
    },
    fileKey
  );
}
```

### File Decryption

```typescript
function decryptFileKey(
  encryptedFileKey: Buffer,
  privateKey: string
): Buffer {
  return crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING
    },
    encryptedFileKey
  );
}

function decryptFile(
  encryptedData: Buffer,
  fileKey: Buffer,
  iv: Buffer,
  authTag: Buffer
): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-gcm', fileKey, iv);
  decipher.setAuthTag(authTag);
  
  return Buffer.concat([
    decipher.update(encryptedData),
    decipher.final()
  ]);
}
```

### Directory Key Operations

```typescript
function generateDirectoryKey(): Buffer {
  return crypto.randomBytes(32); // Generate a random 32-byte (256-bit) key
}

function encryptDirectoryKey(
  directoryKey: Buffer,
  publicKey: string
): Buffer {
  return crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING
    },
    directoryKey
  );
}

function encryptDirectoryKeyWithParentKey(
  directoryKey: Buffer,
  parentDirectoryKey: Buffer
): {
  encryptedKey: Buffer;
  iv: Buffer;
  authTag: Buffer;
} {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', parentDirectoryKey, iv);
  
  const encryptedKey = Buffer.concat([
    cipher.update(directoryKey),
    cipher.final()
  ]);
  
  const authTag = cipher.getAuthTag();
  
  return {
    encryptedKey,
    iv,
    authTag
  };
}

async function shareDirectory(
  directoryId: string,
  ownerId: number,
  targetUserId: number,
  ownerPrivateKey: string
): Promise<void> {
  // 1. Get the encrypted directory key for the owner
  const ownerDirKey = await getEncryptedDirectoryKey(directoryId, ownerId);
  
  // 2. Decrypt the directory key using the owner's private key
  const directoryKey = decryptWithPrivateKey(ownerDirKey.encryptedDirectoryKey, ownerPrivateKey);
  
  // 3. Get the target user's public key
  const targetPublicKey = await getUserPublicKey(targetUserId);
  
  // 4. Encrypt the directory key with the target user's public key
  const encryptedKeyForTarget = encryptWithPublicKey(directoryKey, targetPublicKey);
  
  // 5. Store the encrypted directory key for the target user
  await storeEncryptedDirectoryKey(directoryId, targetUserId, encryptedKeyForTarget);
  
  // 6. The target user now has access to the directory key, which allows access to all files and subdirectories
}
```

### Metadata Encryption

```typescript
function encryptMetadata(
  metadata: { name: string; path: string; [key: string]: any },
  fileKey: Buffer
): {
  encryptedMetadata: Buffer;
  iv: Buffer;
  authTag: Buffer;
} {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', fileKey, iv);
  
  const metadataBuffer = Buffer.from(JSON.stringify(metadata));
  const encryptedMetadata = Buffer.concat([
    cipher.update(metadataBuffer),
    cipher.final()
  ]);
  
  const authTag = cipher.getAuthTag();
  
  return {
    encryptedMetadata,
    iv,
    authTag
  };
}

// Similarly for directory metadata
function encryptDirectoryMetadata(
  metadata: { name: string; [key: string]: any },
  directoryKey: Buffer
): {
  encryptedMetadata: Buffer;
  iv: Buffer;
  authTag: Buffer;
} {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', directoryKey, iv);
  
  const metadataBuffer = Buffer.from(JSON.stringify(metadata));
  const encryptedMetadata = Buffer.concat([
    cipher.update(metadataBuffer),
    cipher.final()
  ]);
  
  const authTag = cipher.getAuthTag();
  
  return {
    encryptedMetadata,
    iv,
    authTag
  };
}

function decryptMetadata(
  encryptedMetadata: Buffer,
  fileKey: Buffer,
  iv: Buffer,
  authTag: Buffer
): { name: string; path: string; [key: string]: any } {
  const decipher = crypto.createDecipheriv('aes-256-gcm', fileKey, iv);
  decipher.setAuthTag(authTag);
  
  const metadataBuffer = Buffer.concat([
    decipher.update(encryptedMetadata),
    decipher.final()
  ]);
  
  return JSON.parse(metadataBuffer.toString());
}

function decryptDirectoryMetadata(
  encryptedMetadata: Buffer,
  directoryKey: Buffer,
  iv: Buffer,
  authTag: Buffer
): { name: string; [key: string]: any } {
  const decipher = crypto.createDecipheriv('aes-256-gcm', directoryKey, iv);
  decipher.setAuthTag(authTag);
  
  const metadataBuffer = Buffer.concat([
    decipher.update(encryptedMetadata),
    decipher.final()
  ]);
  
  return JSON.parse(metadataBuffer.toString());
}
```

## Security Limitations

- **Password Strength**: System security depends on users choosing strong passwords
- **Client Security**: End-to-end encryption requires secure client environment
- **Metadata Analysis**: While content and filenames are encrypted, access patterns may still reveal information
- **Key Backup**: No server-side recovery if user loses password (unless recovery key is enabled)

## Future Enhancements

- **Multi-factor Authentication**: Add additional layer of security for authentication
- **Hardware Security Module (HSM)**: For enterprise deployments, use HSM for key management
- **Versioning**: Implement encrypted file versioning
- **Audit Logging**: Secure logging of file access and sharing events
- **Search**: Implement techniques for searching encrypted content (e.g., encrypted search indices)

## License

This project is licensed under the MIT License - see the LICENSE file for details.

---

## Implementation Roadmap

1. **Core Cryptography Layer**
   - Implement key generation functions
   - Build encryption/decryption utilities
   - Create tests for cryptographic operations

2. **User Management**
   - User registration with key generation
   - Authentication and session management
   - Password change and key rotation

3. **Basic File Operations**
   - Encrypted upload/download
   - Metadata encryption
   - File deletion

4. **Sharing Functionality**
   - Implement directory key hierarchy
   - Directory sharing mechanism
   - File sharing mechanism
   - Public link generation
   - Access control and revocation

5. **UI/UX Development**
   - File browser interface
   - Sharing interface