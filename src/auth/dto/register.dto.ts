import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Length,
  IsOptional,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class RegisterAuthDto {
  @IsString()
  @IsNotEmpty()
  @Length(1, 255)
  password: string;

  @IsString()
  @IsOptional()
  full_name: string;

  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsOptional()
  role?: string;

  @Type(() => Date)
  created_at: Date;

  @Type(() => Date)
  updated_at: Date;
}
