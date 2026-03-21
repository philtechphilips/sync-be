import { Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { config } from '../../config/config.service';

@Injectable()
export class CryptographyService {
  private readonly algorithm = 'aes-256-gcm';
  private readonly key = Buffer.from(config.DB.ENCRYPTION_KEY, 'hex');

  encrypt(text: string | null | undefined): string | null | undefined {
    if (!text) return text;
    try {
      const iv = crypto.randomBytes(12); // GCM recommends 12 bytes IV
      const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);
      const encrypted = Buffer.concat([
        cipher.update(text, 'utf8'),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();
      return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
    } catch (error) {
      console.error('Encryption failed:', error);
      return text;
    }
  }

  decrypt(encryptedText: string | null | undefined): string | null | undefined {
    if (!encryptedText) return encryptedText;
    try {
      const parts = encryptedText.split(':');
      if (parts.length !== 3) return encryptedText; // Not encrypted or old format

      const [ivHex, authTagHex, encryptedHex] = parts;
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');
      const encrypted = Buffer.from(encryptedHex, 'hex');

      const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);
      return decrypted.toString('utf8');
    } catch (error) {
      console.error('Decryption failed:', error);
      return encryptedText; // Fallback to raw text if decryption fails (for legacy data)
    }
  }
}
