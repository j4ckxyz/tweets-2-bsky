import { Plus } from 'lucide-react';
import { PERMISSION_OPTIONS } from '../../lib/constants';
import { useDashboard } from '../../lib/dashboard-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

export function UsersSection() {
  const {
    beginEditUser,
    editingUserForm,
    editingUserId,
    handleCreateUser,
    handleDeleteUser,
    handleResetUserPassword,
    handleSaveEditedUser,
    isAdmin,
    isBusy,
    managedUsers,
    me,
    newUserForm,
    resetEditingUser,
    setAccountsCreatorFilter,
    setActiveTab,
    setEditingUserForm,
    setNewUserForm,
    settingsActiveSection,
  } = useDashboard();
  return settingsActiveSection === 'users' && isAdmin ? (
    <Card className="rounded-none border-0 border-t bg-transparent">
      <CardHeader className="px-0 pb-3 pt-6 sm:px-0">
        <CardTitle>Users</CardTitle>
        <CardDescription>Create users and control what they can see/manage.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-1 px-0 sm:px-0">
        <form className="space-y-3 rounded-lg border border-border/70 bg-muted/20 p-3" onSubmit={handleCreateUser}>
          <p className="text-sm font-semibold">Create User</p>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="new-user-username">Username</Label>
              <Input
                id="new-user-username"
                value={newUserForm.username}
                onChange={(event) => {
                  setNewUserForm((previous) => ({ ...previous, username: event.target.value }));
                }}
                placeholder="operator"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-user-email">Email</Label>
              <Input
                id="new-user-email"
                type="email"
                value={newUserForm.email}
                onChange={(event) => {
                  setNewUserForm((previous) => ({ ...previous, email: event.target.value }));
                }}
                placeholder="operator@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-user-password">Password</Label>
              <Input
                id="new-user-password"
                type="password"
                value={newUserForm.password}
                onChange={(event) => {
                  setNewUserForm((previous) => ({ ...previous, password: event.target.value }));
                }}
                placeholder="Minimum 8 characters"
                required
              />
            </div>
          </div>

          <label className="inline-flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={newUserForm.isAdmin}
              onChange={(event) => {
                setNewUserForm((previous) => ({
                  ...previous,
                  isAdmin: event.target.checked,
                }));
              }}
            />
            Make admin
          </label>

          {!newUserForm.isAdmin ? (
            <div className="grid gap-2 md:grid-cols-2">
              {PERMISSION_OPTIONS.map((permission) => (
                <label
                  key={`new-user-permission-${permission.key}`}
                  className="rounded-md border border-border/70 bg-background px-3 py-2 text-xs"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium">{permission.label}</span>
                    <input
                      type="checkbox"
                      checked={newUserForm.permissions[permission.key]}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setNewUserForm((previous) => ({
                          ...previous,
                          permissions: {
                            ...previous.permissions,
                            [permission.key]: checked,
                          },
                        }));
                      }}
                    />
                  </span>
                  <span className="mt-1 block text-muted-foreground">{permission.help}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Admins always get full access.</p>
          )}

          <Button size="sm" type="submit" disabled={isBusy}>
            <Plus className="mr-2 h-4 w-4" />
            Create user
          </Button>
        </form>

        {managedUsers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
            No user accounts created yet.
          </div>
        ) : (
          <div className="space-y-2">
            {managedUsers.map((user) => {
              const isEditing = editingUserId === user.id;
              const displayName = user.username || user.email || user.id;
              return (
                <div key={`managed-user-${user.id}`} className="rounded-lg border border-border/70 bg-card/60 p-3">
                  {isEditing ? (
                    <div className="space-y-3">
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="space-y-1">
                          <Label htmlFor={`edit-user-username-${user.id}`}>Username</Label>
                          <Input
                            id={`edit-user-username-${user.id}`}
                            value={editingUserForm.username}
                            onChange={(event) => {
                              setEditingUserForm((previous) => ({
                                ...previous,
                                username: event.target.value,
                              }));
                            }}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`edit-user-email-${user.id}`}>Email</Label>
                          <Input
                            id={`edit-user-email-${user.id}`}
                            type="email"
                            value={editingUserForm.email}
                            onChange={(event) => {
                              setEditingUserForm((previous) => ({
                                ...previous,
                                email: event.target.value,
                              }));
                            }}
                          />
                        </div>
                      </div>

                      <label className="inline-flex items-center gap-2 text-sm font-medium">
                        <input
                          type="checkbox"
                          checked={editingUserForm.isAdmin}
                          onChange={(event) => {
                            setEditingUserForm((previous) => ({
                              ...previous,
                              isAdmin: event.target.checked,
                            }));
                          }}
                        />
                        Admin access
                      </label>

                      {!editingUserForm.isAdmin ? (
                        <div className="grid gap-2 md:grid-cols-2">
                          {PERMISSION_OPTIONS.map((permission) => (
                            <label
                              key={`edit-user-permission-${user.id}-${permission.key}`}
                              className="rounded-md border border-border/70 bg-background px-3 py-2 text-xs"
                            >
                              <span className="flex items-center justify-between gap-2">
                                <span className="font-medium">{permission.label}</span>
                                <input
                                  type="checkbox"
                                  checked={editingUserForm.permissions[permission.key]}
                                  onChange={(event) => {
                                    const checked = event.target.checked;
                                    setEditingUserForm((previous) => ({
                                      ...previous,
                                      permissions: {
                                        ...previous.permissions,
                                        [permission.key]: checked,
                                      },
                                    }));
                                  }}
                                />
                              </span>
                              <span className="mt-1 block text-muted-foreground">{permission.help}</span>
                            </label>
                          ))}
                        </div>
                      ) : null}

                      <div className="flex flex-wrap justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={resetEditingUser} type="button">
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => {
                            void handleSaveEditedUser(user.id);
                          }}
                          type="button"
                          disabled={isBusy}
                        >
                          Save user
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <p className="text-sm font-semibold">{displayName}</p>
                          <p className="text-xs text-muted-foreground">
                            {user.email ? `Email: ${user.email}` : 'No email set'}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {user.mappingCount} mappings ({user.activeMappingCount} active)
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Badge variant={user.isAdmin ? 'success' : 'outline'}>
                            {user.isAdmin ? 'Admin' : 'User'}
                          </Badge>
                          {user.id === me?.id ? <Badge variant="secondary">You</Badge> : null}
                        </div>
                      </div>

                      {!user.isAdmin ? (
                        <div className="flex flex-wrap gap-2">
                          {PERMISSION_OPTIONS.filter((permission) => user.permissions[permission.key]).map(
                            (permission) => (
                              <Badge key={`user-perm-${user.id}-${permission.key}`} variant="outline">
                                {permission.label}
                              </Badge>
                            ),
                          )}
                        </div>
                      ) : null}

                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setAccountsCreatorFilter(user.id);
                            setActiveTab('accounts');
                          }}
                        >
                          View Accounts
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => beginEditUser(user)}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            void handleResetUserPassword(user.id);
                          }}
                        >
                          Reset Password
                        </Button>
                        {user.id !== me?.id ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-red-600 hover:text-red-500 dark:text-red-300 dark:hover:text-red-200"
                            onClick={() => {
                              void handleDeleteUser(user);
                            }}
                          >
                            Delete
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  ) : null;
}
