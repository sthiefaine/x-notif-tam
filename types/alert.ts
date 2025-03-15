// types/alert.ts
export interface Alert {
  id: string;
  timeStart: Date;
  timeEnd: Date | null;
  cause: string;
  effect: string;
  headerText: string;
  descriptionText: string;
  url: string | null;
  routeIds: string | null;
  stopIds: string | null;
  createdAt: Date;
  updatedAt: Date;
  isComplement: boolean;
  parentAlertId: string | null;
  complements?: AlertComplement[];
}

export interface AlertComplement {
  id: string;
  headerText: string;
  descriptionText: string;
  timeStart: Date;
  timeEnd: Date | null;
}

export interface AlertsResponse {
  data: Alert[];
  pagination: {
    totalItems: number;
    totalPages: number;
    currentPage: number;
    pageSize: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
}

export interface AlertFilter {
  active?: boolean;
  completed?: boolean;
  upcoming?: boolean;
  route?: string;
  stop?: string;
  timeFrame?: 'today' | 'week' | 'month' | null;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}