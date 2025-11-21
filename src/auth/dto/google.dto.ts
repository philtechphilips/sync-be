import { IsNotEmpty, IsNumber, IsString } from 'class-validator';

export class GoogleDto {
  @IsString()
  @IsNotEmpty()
  accessToken: string;

  @IsNumber()
  @IsNotEmpty()
  expiresIn: number;

  @IsString()
  @IsNotEmpty()
  scope: string;

  @IsString()
  @IsNotEmpty()
  tokenType: string;

  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}
