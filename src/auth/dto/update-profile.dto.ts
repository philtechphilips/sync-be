import { IsOptional, IsString, Length } from 'class-validator';

export class UpdateProfileDto {
  @IsString()
  @IsOptional()
  @Length(1, 100)
  full_name?: string;

  @IsString()
  @IsOptional()
  profile_picture?: string;
}
