import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { config } from '../../config/config.service';

@Injectable()
export class CryptographyService {
  private readonly algorithm = 'aes-256-gcm';
  private readonly key = Buffer.from(config.DB.ENCRYPTION_KEY, 'hex');

  /** Encrypts with AES-256-GCM. Throws instead of ever returning plaintext. */
  encrypt(text: string): string {
    const iv = crypto.randomBytes(12); // GCM recommends 12 bytes IV
    const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(text, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  decrypt(encryptedText: string): string {
    const parts = encryptedText.split(':');
    if (parts.length !== 3) throw new Error('Value is not encrypted');

    const [ivHex, authTagHex, encryptedHex] = parts;
    const decipher = crypto.createDecipheriv(
      this.algorithm,
      this.key,
      Buffer.from(ivHex, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  }
}
