export interface IDateQuery {
  startDate?: Date;
  endDate?: Date;
  selectedDate?: Date;
  pastStartDate?: Date;
  pastEndDate?: Date;
}
export interface IPaginationQuery {
  currentPage: number;
  pageSize: number;
}

export interface IPagination<T> {
  items: T[];
  pagination: {
    total: number;
    currentPage: number;
  };
}

export interface IPaginationWithDate {
  skip: number;
  limit: number;
  startDate?: Date;
  endDate?: Date;
}
