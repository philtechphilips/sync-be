import { IsOptional, IsString, Length, IsObject } from 'class-validator';

export class UpdateProfileDto {
  @IsString()
  @IsOptional()
  @Length(1, 100)
  full_name?: string;

  @IsString()
  @IsOptional()
  profile_picture?: string;

  @IsObject()
  @IsOptional()
  settings?: Record<string, any>;
}
