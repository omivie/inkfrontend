        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(() => {
                if (Auth.user) {
                    document.getElementById('settings-email').textContent = Auth.user.email;
                }
            }, 500);

            document.getElementById('sign-out-btn').addEventListener('click', async () => {
                await Auth.signOut();
                window.location.href = '/html/account/login.html';
            });
        });
