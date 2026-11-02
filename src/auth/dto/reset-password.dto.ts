import { IsNotEmpty, IsString, Length } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  @IsString()
  @Length(8, 128, {
    message: 'Password must be between 8 and 128 characters long',
  })
  password: string;
}
