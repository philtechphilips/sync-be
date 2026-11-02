import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CliLoginInitDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  hostname?: string;
}

export class CliLoginAuthorizeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  loginToken: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  userCode: string;
}

export class CliLoginDenyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  loginToken: string;
}
