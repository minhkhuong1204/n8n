/* eslint-disable no-restricted-syntax */
/* eslint-disable import/no-cycle */
import { Credentials, UserSettings } from 'n8n-core';
import {
	ICredentialDataDecryptedObject,
	ICredentialsDecrypted,
	INodeCredentialTestResult,
	LoggerProxy,
} from 'n8n-workflow';
import { FindManyOptions, FindOneOptions, In } from 'typeorm';

import {
	createCredentialsFromCredentialsEntity,
	CredentialsHelper,
	Db,
	ICredentialsDb,
	ResponseHelper,
} from '..';
import { RESPONSE_ERROR_MESSAGES } from '../constants';
import { CredentialsEntity } from '../databases/entities/CredentialsEntity';
import { SharedCredentials } from '../databases/entities/SharedCredentials';
import { validateEntity } from '../GenericHelpers';
import { externalHooks } from '../Server';

import type { User } from '../databases/entities/User';
import type { CredentialRequest } from '../requests';

export class CredentialsService {
	static async get(
		credential: Partial<ICredentialsDb>,
		options?: { relations: string[] },
	): Promise<ICredentialsDb | undefined> {
		return Db.collections.Credentials.findOne(credential, {
			relations: options?.relations,
		});
	}

	static async getAll(user: User, options?: { relations: string[] }): Promise<ICredentialsDb[]> {
		const SELECT_FIELDS: Array<keyof ICredentialsDb> = [
			'id',
			'name',
			'type',
			'nodesAccess',
			'createdAt',
			'updatedAt',
		];

		// if instance owner, return all credentials

		if (user.globalRole.name === 'owner') {
			return Db.collections.Credentials.find({
				select: SELECT_FIELDS,
				relations: options?.relations,
			});
		}

		// if member, return credentials owned by or shared with member

		const userSharings = await Db.collections.SharedCredentials.find({
			where: {
				user,
			},
		});

		return Db.collections.Credentials.find({
			select: SELECT_FIELDS,
			relations: options?.relations,
			where: {
				id: In(userSharings.map((x) => x.credentialId)),
			},
		});
	}

	static async getMany(filter: FindManyOptions<ICredentialsDb>): Promise<ICredentialsDb[]> {
		return Db.collections.Credentials.find(filter);
	}

	/**
	 * Retrieve the sharing that matches a user and a credential.
	 */
	static async getSharing(
		user: User,
		credentialId: number | string,
		relations: string[] | undefined = ['credentials'],
		{ allowGlobalOwner } = { allowGlobalOwner: true },
	): Promise<SharedCredentials | undefined> {
		const options: FindOneOptions = {
			where: {
				credentials: { id: credentialId },
			},
		};

		// Omit user from where if the requesting user is the global
		// owner. This allows the global owner to view and delete
		// credentials they don't own.
		if (!allowGlobalOwner || user.globalRole.name !== 'owner') {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			options.where.user = { id: user.id };
		}

		if (relations?.length) {
			options.relations = relations;
		}

		return Db.collections.SharedCredentials.findOne(options);
	}

	static createCredentialsFromCredentialsEntity(
		credential: CredentialsEntity,
		encrypt = false,
	): Credentials {
		const { id, name, type, nodesAccess, data } = credential;
		if (encrypt) {
			return new Credentials({ id: null, name }, type, nodesAccess);
		}
		return new Credentials({ id: id.toString(), name }, type, nodesAccess, data);
	}

	static async prepareCreateData(
		data: CredentialRequest.CredentialProperties,
	): Promise<CredentialsEntity> {
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { id, ...rest } = data;

		// This saves us a merge but requires some type casting. These
		// types are compatiable for this case.
		const newCredentials = Db.collections.Credentials.create(
			rest as ICredentialsDb,
		) as CredentialsEntity;

		await validateEntity(newCredentials);

		// Add the date for newly added node access permissions
		for (const nodeAccess of newCredentials.nodesAccess) {
			nodeAccess.date = new Date();
		}

		return newCredentials;
	}

	static async prepareUpdateData(
		data: CredentialRequest.CredentialProperties,
		decryptedData: ICredentialDataDecryptedObject,
	): Promise<CredentialsEntity> {
		// This saves us a merge but requires some type casting. These
		// types are compatiable for this case.
		const updateData = Db.collections.Credentials.create(
			data as ICredentialsDb,
		) as CredentialsEntity;

		await validateEntity(updateData);

		// Add the date for newly added node access permissions
		for (const nodeAccess of updateData.nodesAccess) {
			if (!nodeAccess.date) {
				nodeAccess.date = new Date();
			}
		}

		// Do not overwrite the oauth data else data like the access or refresh token would get lost
		// everytime anybody changes anything on the credentials even if it is just the name.
		if (decryptedData.oauthTokenData) {
			// @ts-ignore
			updateData.data.oauthTokenData = decryptedData.oauthTokenData;
		}
		return updateData;
	}

	static createEncryptedData(
		encryptionKey: string,
		credentialsId: string | null,
		data: CredentialsEntity,
	): ICredentialsDb {
		const credentials = new Credentials(
			{ id: credentialsId, name: data.name },
			data.type,
			data.nodesAccess,
		);

		credentials.setData(data.data as unknown as ICredentialDataDecryptedObject, encryptionKey);

		const newCredentialData = credentials.getDataToSave() as ICredentialsDb;

		// Add special database related data
		newCredentialData.updatedAt = new Date();

		return newCredentialData;
	}

	static async getEncryptionKey(): Promise<string> {
		try {
			return await UserSettings.getEncryptionKey();
		} catch (error) {
			throw new ResponseHelper.ResponseError(
				RESPONSE_ERROR_MESSAGES.NO_ENCRYPTION_KEY,
				undefined,
				500,
			);
		}
	}

	static async decrypt(
		encryptionKey: string,
		credential: CredentialsEntity,
	): Promise<ICredentialDataDecryptedObject> {
		const coreCredential = createCredentialsFromCredentialsEntity(credential);
		return coreCredential.getData(encryptionKey);
	}

	static async update(
		credentialId: string,
		newCredentialData: ICredentialsDb,
	): Promise<ICredentialsDb | undefined> {
		await externalHooks.run('credentials.update', [newCredentialData]);

		// Update the credentials in DB
		await Db.collections.Credentials.update(credentialId, newCredentialData);

		// We sadly get nothing back from "update". Neither if it updated a record
		// nor the new value. So query now the updated entry.
		return Db.collections.Credentials.findOne(credentialId);
	}

	static async save(
		credential: CredentialsEntity,
		encryptedData: ICredentialsDb,
		user: User,
	): Promise<CredentialsEntity> {
		// To avoid side effects
		const newCredential = new CredentialsEntity();
		Object.assign(newCredential, credential, encryptedData);

		await externalHooks.run('credentials.create', [encryptedData]);

		const role = await Db.collections.Role.findOneOrFail({
			name: 'owner',
			scope: 'credential',
		});

		const result = await Db.transaction(async (transactionManager) => {
			const savedCredential = await transactionManager.save<CredentialsEntity>(newCredential);

			savedCredential.data = newCredential.data;

			const newSharedCredential = new SharedCredentials();

			Object.assign(newSharedCredential, {
				role,
				user,
				credentials: savedCredential,
			});

			await transactionManager.save<SharedCredentials>(newSharedCredential);

			return savedCredential;
		});
		LoggerProxy.verbose('New credential created', {
			credentialId: newCredential.id,
			ownerId: user.id,
		});
		return result;
	}

	static async delete(credentials: CredentialsEntity): Promise<void> {
		await externalHooks.run('credentials.delete', [credentials.id]);

		await Db.collections.Credentials.remove(credentials);
	}

	static async test(
		user: User,
		encryptionKey: string,
		credentials: ICredentialsDecrypted,
		nodeToTestWith: string | undefined,
	): Promise<INodeCredentialTestResult> {
		const helper = new CredentialsHelper(encryptionKey);

		return helper.testCredentials(user, credentials.type, credentials, nodeToTestWith);
	}
}
