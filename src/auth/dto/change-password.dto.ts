import { IsNotEmpty, IsString, Length } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  current_password: string;

  @IsString()
  @Length(8, 128, {
    message: 'Password must be between 8 and 128 characters long',
  })
  new_password: string;
}
