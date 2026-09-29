import bcrypt from 'bcryptjs'

const password = process.argv[2]

if (!password || password.length < 10) {
  console.error('用法: npm run admin:hash -- "至少10位的管理员密码"')
  process.exit(1)
}

console.log(await bcrypt.hash(password, 12))
