export type ConnectionStatus = 'invited' | 'pending_confirmation' | 'active' | 'ended';
export type ConnectionSpecialty = 'nutritionist' | 'fitness_coach';
export type ConnectionCanceledReason = 'code_rotated' | null;

export type Connection = {
  id: string;
  status: ConnectionStatus;
  canceledReason: ConnectionCanceledReason;
  specialty: ConnectionSpecialty;
  professionalAuthUid: string;
  studentAuthUid: string;
  sourceInviteCodeId: string | null;
  sourceInviteCodeValue: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
};

export type InviteCode = {
  id: string;
  professionalAuthUid: string;
  specialty: ConnectionSpecialty;
  codeValue: string;
  status: 'active' | 'rotated' | 'revoked';
  rotatedAt: string | null;
  expiresAt: null;
  createdAt: string;
};

export type SubmitInviteCodeInput = {
  code: string;
  studentAuthUid: string;
};

export type ProfessionalInviteCodeInput = {
  professionalAuthUid: string;
  specialty: ConnectionSpecialty;
};

export type ConfirmPendingConnectionInput = {
  connectionId: string;
  professionalAuthUid: string;
};

export type EndConnectionInput = {
  connectionId: string;
  authUid: string;
};

export interface ConnectionRepository {
  listForAuthUid(authUid: string): Promise<Connection[]>;
  getOrCreateActiveInviteCode(input: ProfessionalInviteCodeInput): Promise<InviteCode>;
  rotateInviteCode(input: ProfessionalInviteCodeInput): Promise<InviteCode>;
  submitInviteCode(input: SubmitInviteCodeInput): Promise<Connection>;
  confirmPendingConnection(input: ConfirmPendingConnectionInput): Promise<Connection>;
  endConnection(input: EndConnectionInput): Promise<Connection>;
}

export class InviteCodeNotFoundError extends Error {
  constructor(message = 'Invite code not found.') {
    super(message);
    this.name = 'InviteCodeNotFoundError';
  }
}

export class ConnectionAlreadyExistsError extends Error {
  constructor(message = 'Already connected.') {
    super(message);
    this.name = 'ConnectionAlreadyExistsError';
  }
}

export class ConnectionNotFoundError extends Error {
  constructor(message = 'Connection not found.') {
    super(message);
    this.name = 'ConnectionNotFoundError';
  }
}

export class ConnectionForbiddenError extends Error {
  constructor(message = 'Connection is not owned by the authenticated user.') {
    super(message);
    this.name = 'ConnectionForbiddenError';
  }
}

export class InvalidConnectionTransitionError extends Error {
  constructor(message = 'Invalid connection transition.') {
    super(message);
    this.name = 'InvalidConnectionTransitionError';
  }
}

export class PendingConnectionAlreadyExistsError extends Error {
  constructor(message = 'Pending request already exists.') {
    super(message);
    this.name = 'PendingConnectionAlreadyExistsError';
  }
}

export class PendingConnectionCapReachedError extends Error {
  constructor(message = 'Pending cap reached.') {
    super(message);
    this.name = 'PendingConnectionCapReachedError';
  }
}

export class ProfessionalSubscriptionRequiredError extends Error {
  constructor(message = 'Professional subscription required.') {
    super(message);
    this.name = 'ProfessionalSubscriptionRequiredError';
  }
}
