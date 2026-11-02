import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

export class RegisterAuthDto {
  @IsString()
  @Length(8, 128, {
    message: 'Password must be between 8 and 128 characters long',
  })
  password: string;

  @IsString()
  @IsOptional()
  @Length(1, 100)
  full_name?: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @IsNotEmpty()
  email: string;
}
