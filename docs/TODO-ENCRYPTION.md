# Secure File Sharing System with End-to-End Encryption

> **TLDR**: Future design — E2E encryption with hybrid crypto (RSA user keys + AES-256-GCM per-file). Key hierarchy:
> password → user key pair → directory keys → file keys. Not yet implemented.

This repository contains a secure file sharing system similar to Google Drive, with robust end-to-end encryption to
protect content and metadata.

## Architecture Overview

The system implements a hybrid cryptographic approach:

1. **User Key Management**: Each user has a public/private key pair.
2. **Directory Key Hierarchy**: Directory keys encrypt file keys and subdirectory keys.
3. **Per-file Encryption**: Each file has its own symmetric encryption key.
4. **Encrypted Metadata**: Sensitive metadata (filenames, paths) is encrypted separately.
5. **Secure Sharing**: Directories and files can be shared without re-encrypting content.

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

### Authentication & Key Generation

1. **Registration**: System generates RSA key pair. Private key is encrypted with PBKDF2-derived password key.
2. **Authentication**: Password decrypts private key, held in memory during the session.

### File Encryption

1. **Upload**: Generate AES-256 file key. Encrypt content (AES-256-GCM) and metadata. Encrypt file key with directory
   key.
2. **Download**: Decrypt directory key with user private key. Decrypt file key. Decrypt content.

### Sharing Mechanism

1. **Share File**: Owner decrypts file key, re-encrypts it with recipient's public key.
2. **Share Directory**: Owner decrypts directory key, re-encrypts it with recipient's public key. Recipient gains access
   to all contents.
3. **Revocation**: Delete the encrypted key record for the revoked user.

### Metadata Protection

1. **Non-sensitive** (unencrypted): ID, size, MIME type, timestamps.
2. **Sensitive** (encrypted): File name, path, custom tags.

## Database Schema

```sql
-- Core Tables
CREATE TABLE users (id SERIAL PRIMARY KEY, username VARCHAR UNIQUE, password_hash TEXT);
CREATE TABLE user_keys (user_id INTEGER PRIMARY KEY, encrypted_private_key BYTEA, public_key TEXT, salt BYTEA, iv BYTEA, auth_tag BYTEA);
CREATE TABLE directories (id VARCHAR PRIMARY KEY, parent_id VARCHAR, created_by INTEGER);
CREATE TABLE files (id VARCHAR PRIMARY KEY, directory_id VARCHAR, mime_type VARCHAR, size BIGINT, created_by INTEGER);

-- Encryption/Sharing Tables
CREATE TABLE directory_keys (directory_id VARCHAR, user_id INTEGER, encrypted_directory_key BYTEA, iv BYTEA, auth_tag BYTEA, PRIMARY KEY (directory_id, user_id));
CREATE TABLE encrypted_directory_metadata (directory_id VARCHAR, user_id INTEGER, encrypted_metadata BYTEA, iv BYTEA, auth_tag BYTEA, PRIMARY KEY (directory_id, user_id));
CREATE TABLE file_keys (file_id VARCHAR, directory_id VARCHAR, user_id INTEGER, encrypted_file_key BYTEA, iv BYTEA, auth_tag BYTEA, PRIMARY KEY (file_id, user_id));
CREATE TABLE encrypted_file_metadata (file_id VARCHAR, user_id INTEGER, encrypted_metadata BYTEA, iv BYTEA, auth_tag BYTEA, PRIMARY KEY (file_id, user_id));
```

## API Endpoints

- **Users**: `/api/users/register`, `login`, `logout`, `change-password`
- **Directories**: `/api/directories/create`, `list`, `rename`, `delete`
- **Files**: `/api/files/upload`, `download`, `rename`, `delete`
- **Sharing**: `/api/files/share`, `/api/directories/share`, `revoke`

## Implementation Guidelines

- **Standards**: RSA-2048, AES-256-GCM, PBKDF2 with SHA-256 (100k+ iterations).
- **Security**: Zero-knowledge server. Clear sensitive data from memory after use. Support key rotation.
- **Performance**: Encrypt large files in chunks. Cache decrypted metadata during session.

## Code Examples

### File Encryption

```typescript
function encryptFile(fileData: Buffer, fileKey: Buffer = crypto.randomBytes(32)) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', fileKey, iv);
  return {
    encryptedData: Buffer.concat([cipher.update(fileData), cipher.final()]),
    iv, authTag: cipher.getAuthTag(), fileKey
  };
}

function encryptFileKey(fileKey: Buffer, publicKey: string) {
  return crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, fileKey);
}
```

### Directory Sharing

```typescript
async function shareDirectory(directoryId: string, ownerId: number, targetUserId: number, ownerPrivateKey: string) {
  const ownerDirKey = await getEncryptedDirectoryKey(directoryId, ownerId);
  const directoryKey = decryptWithPrivateKey(ownerDirKey.encryptedDirectoryKey, ownerPrivateKey);
  const targetPublicKey = await getUserPublicKey(targetUserId);
  const encryptedKeyForTarget = encryptWithPublicKey(directoryKey, targetPublicKey);
  await storeEncryptedDirectoryKey(directoryId, targetUserId, encryptedKeyForTarget);
}
```

## Security Limitations

- Depends on strong user passwords.
- Requires secure client environment.
- Access patterns may reveal information (metadata analysis).
- No server-side recovery without explicit recovery keys.
